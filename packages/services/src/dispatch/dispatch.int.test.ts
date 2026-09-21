import { businessMonth, type DomainError, type PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { aSellingSeller } from '../../test/sales';
import { getMyCashInHand } from '../cash';
import { listMyNotifications } from '../notifications';
import { setPriceListItems } from '../pricing';
import { decideDiscountRequest, getSale, listSales } from '../sales';
import { getDb } from '../runtime';
import { adjustBalance, listStoreLedger } from '../stores';
import { actualsFor } from '../targets';
import { basePriceListId } from '../../test/stores';
import {
  cancelOrder, confirmReceipt, createOrderForSeller, decideLostClaim, dispatchApprovedSale, dispatchOptions, getDispatchOrder, listDispatchOrders,
  raiseDispatchOrder, raiseLostClaim, releaseOrder, releaseOrderBack, resolveShortfall, takeOrder,
} from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async (now?: Date) => ctxFor(await anAccount('ADMIN'), now ? { now } : {});
const manager = async (grants: PermissionCode[]) => ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });

/** Packs of a SKU by account, from the stock ledger. */
async function positions(skuId: string) {
  const rows = await ownerQuery<{ account_kind: string; q: string }>(
    'select m.account_kind, sum(m.quantity)::text as q from stock_movements m join batches b on b.id = m.batch_id where b.sku_id = $1 group by m.account_kind', [skuId]);
  return Object.fromEntries(rows.map((r) => [r.account_kind, Number(r.q)]));
}

/** A seller at work with a store, bags on the vehicle, and bags and pouches (both priced) in the warehouse. */
async function aDispatchSetup(opts: Parameters<typeof aSellingSeller>[1] = {}) {
  const ctx = await admin();
  const setup = await aSellingSeller(ctx, { packs: 4, ...opts }); // 20 bags received: 4 on the vehicle, 16 in the warehouse; 10 pouches
  await setPriceListItems(ctx, await basePriceListId(), [{ skuId: setup.pouch.id, price: '20.00' }]);
  return { ctx, ...setup };
}

const lines = (s: { bag: { id: string }; pouch: { id: string } }, bags = 3, pouches = 2) => [{ skuId: s.bag.id, packs: bags }, { skuId: s.pouch.id, packs: pouches }];

describe('raising a dispatch order (workflow J, DSP-001..003)', () => {
  it('DSP-002, DSP-003: priced and checked like a sale — then pending: nothing posted, the warehouse told', async () => {
    const s = await aDispatchSetup();
    const options = await dispatchOptions(s.seller.ctx, s.store.id);
    expect(options.items.map((i) => [i.code, i.unitPrice, i.warehousePacks])).toEqual([[s.pouch.code, '20.00', 10], [s.bag.code, '90.00', 16]].sort());
    const { saleId, orderId } = await raiseDispatchOrder(s.seller.ctx, { storeId: s.store.id, lines: lines(s) });
    const order = await getDispatchOrder(s.seller.ctx, orderId ?? '');
    expect(order).toMatchObject({ status: 'REQUESTED', forSeller: false, sale: { id: saleId, status: 'PENDING_DELIVERY', total: '310.00' } });
    expect(order.number).toMatch(/^DO-\d{4}-\d{4}$/);
    expect(await listStoreLedger(s.ctx, s.store.id)).toEqual([]);
    expect(await positions(s.bag.id)).toMatchObject({ WAREHOUSE: 80_000, VEHICLE: 20_000 });
    expect((await listMyNotifications(s.ctx)).items.map((n) => n.kind)).toContain('DISPATCH_REQUESTED');
    expect(await getSale(s.seller.ctx, saleId)).toMatchObject({ channel: 'DISPATCH', vehicle: null, dispatchOrder: { id: orderId } });
  });

  it('DSP-002, OQ-018: orders waiting for delivery count against the store\'s credit', async () => {
    const s = await aDispatchSetup({ creditLimit: '500.00' });
    await raiseDispatchOrder(s.seller.ctx, { storeId: s.store.id, lines: [{ skuId: s.bag.id, packs: 3 }] }); // 270.00
    expect(await code(raiseDispatchOrder(s.seller.ctx, { storeId: s.store.id, lines: [{ skuId: s.bag.id, packs: 3 }] }))).toBe('CREDIT_LIMIT_EXCEEDED');
    await adjustBalance(s.ctx, s.store.id, { amount: '10.00', reason: 'Old debt', dueOn: '2026-01-01' });
    expect(await code(raiseDispatchOrder(s.seller.ctx, { storeId: s.store.id, lines: [{ skuId: s.bag.id, packs: 1 }] }))).toBe('CREDIT_BLOCKED');
  });

  it('DSP-002, PRC-009: above the ceiling it waits for approval; approved, whoever raised it sends it on', async () => {
    const s = await aDispatchSetup();
    const input = { storeId: s.store.id, lines: [{ skuId: s.bag.id, packs: 2, discount: '12' }] };
    expect(await code(raiseDispatchOrder(s.seller.ctx, input))).toBe('DISCOUNT_ABOVE_CEILING');
    const { saleId, orderId } = await raiseDispatchOrder(s.seller.ctx, { ...input, approvalReason: 'Big season order' });
    expect(orderId).toBeNull();
    const pending = await getSale(s.seller.ctx, saleId);
    const approved = await decideDiscountRequest(s.ctx, saleId, { version: pending.version, approve: true });
    const sent = await dispatchApprovedSale(s.seller.ctx, saleId, { version: approved.version });
    expect(await getDispatchOrder(s.seller.ctx, sent.orderId ?? '')).toMatchObject({ status: 'REQUESTED', sale: { status: 'PENDING_DELIVERY', total: '158.40' } });
  });
});

describe('handling and release (DSP-004..008)', () => {
  it('DSP-004, DSP-005: taking shows the manager\'s name — a label another manager can take over, or hand back', async () => {
    const s = await aDispatchSetup();
    const { orderId } = await raiseDispatchOrder(s.seller.ctx, { storeId: s.store.id, lines: lines(s) });
    const taken = await takeOrder(s.ctx, orderId ?? '', { version: 1 });
    expect(taken).toMatchObject({ status: 'BEING_HANDLED', handledBy: { id: s.ctx.user.id } });
    const other = await manager(['sales.fulfil_dispatch']);
    const takenOver = await takeOrder(other, taken.id, { version: taken.version });
    expect(takenOver.handledBy?.id).toBe(other.user.id);
    expect(takenOver.events.at(-1)).toMatchObject({ type: 'TAKEN', note: taken.handledBy?.name });
    const back = await releaseOrderBack(other, taken.id, { version: takenOver.version });
    expect(back).toMatchObject({ status: 'REQUESTED', handledBy: null });
  });

  it('DSP-006, DSP-007, DSP-008: release needs the transport slip photo; stock leaves the warehouse for the dispatched position — never a vehicle', async () => {
    const s = await aDispatchSetup();
    const { orderId } = await raiseDispatchOrder(s.seller.ctx, { storeId: s.store.id, lines: lines(s) });
    const id = orderId ?? '';
    const wrong = await aPhoto(s.ctx, 'WRITE_OFF_EVIDENCE');
    expect(await code(releaseOrder(s.ctx, id, { version: 1, transportSlipPhotoId: wrong }))).toBe('EVIDENCE_REQUIRED');
    const released = await releaseOrder(s.ctx, id, { version: 1, transportSlipPhotoId: await aPhoto(s.ctx, 'TRANSPORT_SLIP'), transportNote: 'Al-Majd Transport, truck 4411' });
    expect(released).toMatchObject({ status: 'RELEASED', releasedBy: { id: s.ctx.user.id }, transportNote: 'Al-Majd Transport, truck 4411' });
    expect(released.lines.map((l) => l.batches.reduce((n, b) => n + b.packs, 0))).toEqual([2, 3]);
    expect(await positions(s.bag.id)).toMatchObject({ WAREHOUSE: 65_000, DISPATCHED: 15_000, VEHICLE: 20_000 });
    expect((await listMyNotifications(s.seller.ctx)).items.map((n) => n.kind)).toContain('DISPATCH_RELEASED');
    expect(await code(cancelOrder(s.seller.ctx, id, { version: released.version, reason: 'Changed mind' }))).toBe('INVALID_TRANSITION');
  });

  it('OQ-019: nothing is reserved while it waits — without enough in the warehouse at release, it waits', async () => {
    const s = await aDispatchSetup();
    const { orderId } = await raiseDispatchOrder(s.seller.ctx, { storeId: s.store.id, lines: [{ skuId: s.bag.id, packs: 17 }] });
    expect(await code(releaseOrder(s.ctx, orderId ?? '', { version: 1, transportSlipPhotoId: await aPhoto(s.ctx, 'TRANSPORT_SLIP') }))).toBe('INSUFFICIENT_STOCK');
    expect(await positions(s.bag.id)).toMatchObject({ WAREHOUSE: 80_000 });
  });

  it('STATE-MACHINES §3: before release, cancelled with a reason; the pending sale goes with it', async () => {
    const s = await aDispatchSetup();
    const { orderId, saleId } = await raiseDispatchOrder(s.seller.ctx, { storeId: s.store.id, lines: lines(s) });
    expect(await code(cancelOrder(s.seller.ctx, orderId ?? '', { version: 1, reason: ' ' }))).toBe('REASON_REQUIRED');
    const cancelled = await cancelOrder(s.seller.ctx, orderId ?? '', { version: 1, reason: 'Store closed for renovation' });
    expect(cancelled).toMatchObject({ status: 'CLOSED', closeReason: 'CANCELLED', cancelReason: 'Store closed for renovation' });
    expect(await getSale(s.seller.ctx, saleId)).toMatchObject({ status: 'CANCELLED', cancelReason: 'REQUEST_CANCELLED' });
  });
});

describe('receipt (DSP-009..012, OQ-019)', () => {
  async function released(s: Awaited<ReturnType<typeof aDispatchSetup>>) {
    const { orderId, saleId } = await raiseDispatchOrder(s.seller.ctx, { storeId: s.store.id, lines: lines(s) });
    const order = await releaseOrder(s.ctx, orderId ?? '', { version: 1, transportSlipPhotoId: await aPhoto(s.ctx, 'TRANSPORT_SLIP') });
    return { order, saleId };
  }
  const line = (order: Awaited<ReturnType<typeof released>>['order'], code: string) => order.lines.find((l) => l.code === code)?.id ?? '';

  it('DSP-009, DSP-010: confirmed in full, in person — the sale is recorded, the store owes it, the document is numbered', async () => {
    const s = await aDispatchSetup();
    const { order, saleId } = await released(s);
    const done = await confirmReceipt(s.seller.ctx, order.id, {
      version: order.version, mode: 'IN_PERSON',
      lines: [{ lineId: line(order, s.bag.code), received: 3, short: 0, damaged: 0 }, { lineId: line(order, s.pouch.code), received: 2, short: 0, damaged: 0 }],
    });
    expect(done).toMatchObject({ status: 'CLOSED', closeReason: 'DELIVERED', confirmationMode: 'IN_PERSON', sale: { status: 'COMPLETED', total: '310.00' } });
    const sale = await getSale(s.seller.ctx, saleId);
    expect(sale.status).toBe('COMPLETED');
    expect(sale.document?.number).toMatch(/^DN-/);
    expect((await listStoreLedger(s.ctx, s.store.id))[0]).toMatchObject({ entryType: 'SALE', amount: '310.00' });
    expect(await positions(s.bag.id)).toMatchObject({ DISPATCHED: 0, SOLD: 15_000 });
  });

  it('DSP-011, DSP-012, OQ-019: short and damaged, line by line on the owner\'s word — the store pays for what arrived; the rest is written off; the gap is resolved', async () => {
    const s = await aDispatchSetup();
    const { order } = await released(s);
    const bag = line(order, s.bag.code);
    const pouch = line(order, s.pouch.code);
    expect(await code(confirmReceipt(s.seller.ctx, order.id, { version: order.version, mode: 'OWNER_WORD', lines: [{ lineId: bag, received: 2, short: 0, damaged: 0 }, { lineId: pouch, received: 2, short: 0, damaged: 0 }] })))
      .toBe('RECEIPT_MISMATCH');
    expect(await code(confirmReceipt(s.seller.ctx, order.id, { version: order.version, mode: 'OWNER_WORD', lines: [{ lineId: bag, received: 0, short: 3, damaged: 0 }, { lineId: pouch, received: 0, short: 2, damaged: 0 }] })))
      .toBe('NOTHING_RECEIVED');
    const delivered = await confirmReceipt(s.seller.ctx, order.id, {
      version: order.version, mode: 'OWNER_WORD', lines: [{ lineId: bag, received: 2, short: 1, damaged: 0 }, { lineId: pouch, received: 1, short: 0, damaged: 1 }],
    });
    expect(delivered).toMatchObject({ status: 'DELIVERED', confirmationMode: 'OWNER_WORD', sale: { status: 'COMPLETED', total: '200.00' } });
    expect(delivered.lines.map((l) => [l.code, l.receivedPacks, l.shortPacks, l.damagedPacks])).toEqual([[s.pouch.code, 1, 0, 1], [s.bag.code, 2, 1, 0]]);
    expect(await positions(s.bag.id)).toMatchObject({ DISPATCHED: 0, SOLD: 10_000, WRITTEN_OFF: 5_000 });
    expect((await listStoreLedger(s.ctx, s.store.id))[0]).toMatchObject({ amount: '200.00' });
    const closed = await resolveShortfall(s.seller.ctx, order.id, { version: delivered.version, resolution: 'FURTHER_ORDER' });
    expect(closed).toMatchObject({ status: 'CLOSED', closeReason: 'DELIVERED', resolution: 'FURTHER_ORDER' });
  });

  it('SAL-006, CSH-001: a bill-to-bill store pays for what arrived when it arrives', async () => {
    const s = await aDispatchSetup({ creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    const { order } = await released(s);
    const all = [{ lineId: line(order, s.bag.code), received: 3, short: 0, damaged: 0 }, { lineId: line(order, s.pouch.code), received: 2, short: 0, damaged: 0 }];
    expect(await code(confirmReceipt(s.seller.ctx, order.id, { version: order.version, mode: 'IN_PERSON', lines: all }))).toBe('PAYMENT_REQUIRED');
    await confirmReceipt(s.seller.ctx, order.id, { version: order.version, mode: 'IN_PERSON', lines: all, payment: { method: 'CASH' } });
    expect(await getMyCashInHand(s.seller.ctx)).toEqual({ cashInHand: '310.00' });
  });
});

describe('lost orders (DSP-013) and the unconfirmed flag (DSP-014)', () => {
  it('DSP-013: the seller claims it never arrived; approved by someone else, the stock is written off and the sale cancelled', async () => {
    const s = await aDispatchSetup();
    const { orderId, saleId } = await raiseDispatchOrder(s.seller.ctx, { storeId: s.store.id, lines: lines(s) });
    const order = await releaseOrder(s.ctx, orderId ?? '', { version: 1, transportSlipPhotoId: await aPhoto(s.ctx, 'TRANSPORT_SLIP') });
    const claimed = await raiseLostClaim(s.seller.ctx, order.id, { version: order.version, reason: 'Driver never arrived; transport company unreachable' });
    expect(claimed.claims).toMatchObject([{ status: 'PENDING' }]);
    expect(await code(confirmReceipt(s.seller.ctx, order.id, { version: claimed.version, mode: 'IN_PERSON', lines: [] }))).toBe('CLAIM_PENDING');
    expect((await listMyNotifications(s.ctx)).items.map((n) => n.kind)).toContain('LOST_CLAIM_RAISED');
    expect(await code(decideLostClaim(s.ctx, order.id, { version: claimed.version, approve: false }))).toBe('REASON_REQUIRED');
    const rejected = await decideLostClaim(s.ctx, order.id, { version: claimed.version, approve: false, comment: 'The transporter has proof of delivery' });
    expect(rejected).toMatchObject({ status: 'RELEASED', claims: [{ status: 'REJECTED' }] });

    const again = await raiseLostClaim(s.seller.ctx, order.id, { version: rejected.version, reason: 'Store confirms nothing came' });
    const approver = await manager(['sales.approve_lost_order']);
    const lost = await decideLostClaim(approver, order.id, { version: again.version, approve: true, comment: 'Confirmed with the transporter' });
    expect(lost).toMatchObject({ status: 'CLOSED', closeReason: 'LOST' });
    expect(await getSale(s.seller.ctx, saleId)).toMatchObject({ status: 'CANCELLED', cancelReason: 'LOST' });
    expect(await positions(s.bag.id)).toMatchObject({ DISPATCHED: 0, WRITTEN_OFF: 15_000 });
    expect(await listStoreLedger(s.ctx, s.store.id)).toEqual([]);
  });

  it('DSP-014: released and unconfirmed past the configured days, it is flagged', async () => {
    const s = await aDispatchSetup();
    const { orderId } = await raiseDispatchOrder(s.seller.ctx, { storeId: s.store.id, lines: lines(s) });
    await releaseOrder(s.ctx, orderId ?? '', { version: 1, transportSlipPhotoId: await aPhoto(s.ctx, 'TRANSPORT_SLIP') });
    expect((await listDispatchOrders(s.ctx, { unconfirmed: true })).items).toEqual([]);
    const later = await ctxFor({ id: s.ctx.user.id, role: 'ADMIN' }, { now: new Date(Date.now() + 6 * 86_400_000) });
    expect((await listDispatchOrders(later, { unconfirmed: true })).items).toMatchObject([{ id: orderId, unconfirmed: true }]);
  });
});

describe('orders on a seller\'s behalf (workflow K, DSP-015..017)', () => {
  it('DSP-015, DSP-016, DSP-017: attributed to the store\'s seller, who is told at once and confirms receipt as their own', async () => {
    const s = await aDispatchSetup();
    const office = await manager(['sales.create_order_for_seller', 'stores.view_all']);
    const { orderId, saleId } = await createOrderForSeller(office, { storeId: s.store.id, lines: lines(s, 1, 1) });
    const order = await getDispatchOrder(s.seller.ctx, orderId ?? '');
    expect(order).toMatchObject({ forSeller: true, seller: { id: s.seller.account.id }, raisedBy: { id: office.user.id } });
    expect((await listMyNotifications(s.seller.ctx)).items.map((n) => n.kind)).toContain('DISPATCH_CREATED_FOR_YOU');
    expect((await listSales(s.seller.ctx, {})).items.map((x) => x.id)).toContain(saleId);
    const released = await releaseOrder(s.ctx, order.id, { version: order.version, transportSlipPhotoId: await aPhoto(s.ctx, 'TRANSPORT_SLIP') });
    const done = await confirmReceipt(s.seller.ctx, order.id, { version: released.version, mode: 'IN_PERSON', lines: released.lines.map((l) => ({ lineId: l.id, received: l.packs, short: 0, damaged: 0 })) });
    expect(done).toMatchObject({ status: 'CLOSED', sale: { status: 'COMPLETED', total: '110.00' } });
    expect(await getSale(s.seller.ctx, saleId)).toMatchObject({ seller: { id: s.seller.account.id }, raisedBy: office.user.id });

    // Workflow K: and it counts toward the seller's month. Nothing asserted
    // this before — that a manager's order becomes the seller's completed sale
    // was proved above, and that targets count completed sales was proved in
    // targets, but the two were never put together.
    expect(await actualsFor(getDb(), s.seller.account.id, businessMonth(s.ctx.now))).toMatchObject({ REVENUE: '110.00' });
  });

  it('PRC-013, ADR-0038: a manager who raised a discounted order cannot approve it', async () => {
    const s = await aDispatchSetup();
    const office = await manager(['sales.create_order_for_seller', 'sales.approve_discount']);
    const { saleId } = await createOrderForSeller(office, { storeId: s.store.id, lines: [{ skuId: s.bag.id, packs: 1, discount: '12' }], approvalReason: 'Loyal store' });
    const pending = await getSale(office, saleId);
    expect(await code(decideDiscountRequest(office, saleId, { version: pending.version, approve: true }))).toBe('FOUR_EYES');
  });
});
