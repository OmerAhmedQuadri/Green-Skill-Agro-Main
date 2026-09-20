import type { DomainError } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { aSellingSeller } from '../../test/sales';
import { basePriceListId } from '../../test/stores';
import { aLoadedVehicle } from '../../test/vehicles';
import { cashInHand } from '../cash';
import { confirmReceipt, raiseDispatchOrder, releaseOrder } from '../dispatch';
import { setPriceListItems } from '../pricing';
import { getDb } from '../runtime';
import { recordSale } from '../sales';
import { getCreditStatus, listStoreLedger, recordPayment } from '../stores';
import { updateSettings } from '../system';
import { getMyVehicle } from '../vehicles';
import { getReturn, getReturnable, listReturns, myRefundsDue, mySalesMonth, payRefundDue, recordReturn } from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async (now?: Date) => ctxFor(await anAccount('ADMIN'), now ? { now } : {});
const year = new Date().toISOString().slice(0, 4);
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const vehiclePacks = async (ctx: Parameters<typeof getMyVehicle>[0]) => (await getMyVehicle(ctx)).packs;
const movements = (referenceId: string) => ownerQuery<{ batch_id: string; account_kind: string; quantity: string }>(
  'select batch_id, account_kind, quantity from stock_movements where reference_id = $1 order by account_kind::text, quantity', [referenceId]);

/** A completed sale of `packs` Okra bags at 90.00 — the line and the batch it came from. */
async function aSale(opts: Parameters<typeof aSellingSeller>[1] & { sold?: number; payment?: { method: 'CASH' | 'BANK_TRANSFER'; reference?: string } } = {}) {
  const ctx = await admin();
  const setup = await aSellingSeller(ctx, opts);
  const sale = await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: opts.sold ?? 4 }], ...(opts.payment ? { payment: opts.payment } : {}) });
  const line = sale.lines[0];
  const batchId = line?.batches[0]?.batchId;
  if (!line || !batchId) throw new Error('sale line missing');
  return { ...setup, admin: ctx, sale, line, batchId };
}

describe('from the sale (workflow L, RET-001..006)', () => {
  it('RET-001, RET-002, RET-005: the returnable view — what the store holds from the sale, what is unpaid, each condition and its window', async () => {
    const { seller, sale, line, batchId } = await aSale();
    const view = await getReturnable(seller.ctx, sale.id);
    expect(view).toMatchObject({
      unpaid: '360.00', otherDebts: '0.00', place: { kind: 'VEHICLE', notWorking: null, cashInHand: '0.00' }, returns: [],
      conditions: [
        { condition: 'UNCLEARED_PAYMENT', windowDays: 30, daysLeft: 30, blockedBy: null },
        { condition: 'DEFECTIVE', windowDays: 30, daysLeft: 30, blockedBy: null },
      ],
      lines: [{ saleLineId: line.id, code: 'OKRA-PK-5KG', packs: 4, total: '360.00', credited: 0, batches: [{ batchId, lotNumber: 'W1', expiresOn: '2027-12-31', expired: false, packs: 4 }] }],
    });
  });

  it('RET-001: only a completed sale of the seller\'s own, and never more than the store still holds from it', async () => {
    const { seller, sale, line, batchId, admin: ctx } = await aSale();
    const other = await aLoadedVehicle(ctx, 2);
    const take = (packs: number) => ({ saleId: sale.id, kind: 'CREDIT_NOTE' as const, condition: 'UNCLEARED_PAYMENT' as const, lines: [{ saleLineId: line.id, batchId, packs }] });
    expect(await code(recordReturn(other.seller.ctx, take(1)))).toBe('NOT_FOUND');
    expect(await code(getReturnable(other.seller.ctx, sale.id))).toBe('NOT_FOUND');
    expect(await code(recordReturn(seller.ctx, take(5)))).toBe('RETURN_EXCEEDS_HELD');
    expect(await code(recordReturn(seller.ctx, { ...take(1), lines: [] }))).toBe('EMPTY_RETURN');
    await recordReturn(seller.ctx, take(3));
    expect(await code(recordReturn(seller.ctx, take(2)))).toBe('RETURN_EXCEEDS_HELD');
    expect((await getReturnable(seller.ctx, sale.id)).lines[0]).toMatchObject({ credited: 3, batches: [{ batchId, packs: 1 }] });
    const pending = await recordSale(seller.ctx, { storeId: sale.store.id, lines: [{ skuId: line.skuId, packs: 1, discount: '12' }], approvalReason: 'Loyal store' });
    expect(await code(getReturnable(seller.ctx, pending.id))).toBe('SALE_NOT_COMPLETED');
  });

  it('RET-004, RET-006: the Admin can allow one condition only, and each keeps its own window', async () => {
    const { sale, line, batchId, admin: ctx } = await aSale();
    const input = (condition: 'UNCLEARED_PAYMENT' | 'DEFECTIVE') => ({ saleId: sale.id, kind: 'CREDIT_NOTE' as const, condition, lines: [{ saleLineId: line.id, batchId, packs: 1 }], warehouseId: null });
    await updateSettings(ctx, [{ key: 'returns.uncleared_payment_allowed', value: false }, { key: 'returns.defective_window_days', value: 7 }]);
    expect(await code(recordReturn(ctx, input('UNCLEARED_PAYMENT')))).toBe('RETURN_CONDITION_DISABLED');
    const later = await admin(days(8));
    expect(await code(recordReturn(later, input('DEFECTIVE')))).toBe('RETURN_WINDOW_CLOSED');
    await updateSettings(ctx, [{ key: 'returns.uncleared_payment_allowed', value: true }]);
    expect((await getReturnable(later, sale.id)).conditions).toEqual([
      { condition: 'UNCLEARED_PAYMENT', windowDays: 30, daysLeft: 22, blockedBy: null },
      { condition: 'DEFECTIVE', windowDays: 7, daysLeft: -1, blockedBy: 'RETURN_WINDOW_CLOSED' },
    ]);
  });

  it('RET-002, OQ-020: part-paid — no more than the unpaid part comes back unpaid; a paid sale is not "not yet cleared"', async () => {
    const { seller, sale, line, batchId } = await aSale();
    await recordPayment(seller.ctx, { storeId: sale.store.id, amount: '300.00', method: 'CASH' });
    const input = (packs: number) => ({ saleId: sale.id, kind: 'CREDIT_NOTE' as const, condition: 'UNCLEARED_PAYMENT' as const, lines: [{ saleLineId: line.id, batchId, packs }] });
    expect((await getReturnable(seller.ctx, sale.id)).unpaid).toBe('60.00');
    expect(await code(recordReturn(seller.ctx, input(1)))).toBe('RETURN_EXCEEDS_UNPAID');
    await recordPayment(seller.ctx, { storeId: sale.store.id, amount: '60.00', method: 'CASH' });
    expect(await code(recordReturn(seller.ctx, input(1)))).toBe('SALE_ALREADY_PAID');
  });
});

describe('the credit note (RET-007, RET-008, OQ-020)', () => {
  it('RET-007, RET-008: not yet cleared — the bag goes back on its own batch onto the vehicle; the store owes that much less', async () => {
    const { seller, sale, line, batchId } = await aSale();
    expect(await vehiclePacks(seller.ctx)).toBe(6);
    const credit = await recordReturn(seller.ctx, { saleId: sale.id, kind: 'CREDIT_NOTE', condition: 'UNCLEARED_PAYMENT', lines: [{ saleLineId: line.id, batchId, packs: 1 }] });
    expect(credit).toMatchObject({
      number: `CN-${year}-000001`, kind: 'CREDIT_NOTE', amount: '90.00', toSale: '90.00', toOtherDebts: '0.00', refund: '0.00', collectedPortion: '0.00',
      seller: { id: seller.account.id }, processedBy: { id: seller.account.id }, vehicle: { id: expect.any(String) as string }, warehouse: null,
      lines: [{ saleLineId: line.id, packs: 1, outcome: 'RESTOCK', amount: '90.00', batch: { batchId, lotNumber: 'W1', expiresOn: '2027-12-31' }, replacements: [] }],
    });
    expect(await vehiclePacks(seller.ctx)).toBe(7);
    expect(await movements(credit.id)).toEqual([
      { batch_id: batchId, account_kind: 'SOLD', quantity: '-5000.000' }, { batch_id: batchId, account_kind: 'VEHICLE', quantity: '5000.000' },
    ]);
    expect((await getCreditStatus(seller.ctx, sale.store.id)).outstanding).toBe('270.00');
    const ledger = await listStoreLedger(seller.ctx, sale.store.id);
    expect(ledger.find((e) => e.entryType === 'CREDIT_NOTE')).toMatchObject({ amount: '-90.00' });
    expect(await getReturn(seller.ctx, credit.id)).toEqual(credit);
  });

  it('RET-007, RET-011: goods that cannot be sold again are written off at once — an approved write-off linked to the return', async () => {
    const { seller, sale, line, batchId } = await aSale();
    const credit = await recordReturn(seller.ctx, {
      saleId: sale.id, kind: 'CREDIT_NOTE', condition: 'UNCLEARED_PAYMENT', note: 'Torn in the store', lines: [{ saleLineId: line.id, batchId, packs: 2, saleable: false }],
    });
    expect(credit.lines).toMatchObject([{ packs: 2, outcome: 'WRITE_OFF', amount: '180.00' }]);
    expect(await vehiclePacks(seller.ctx)).toBe(6);
    expect(await ownerQuery('select status, reason, account_kind, requested_packs, approved_quantity from write_offs where return_id = $1', [credit.id]))
      .toEqual([{ status: 'APPROVED', reason: 'DAMAGED', account_kind: 'SOLD', requested_packs: 2, approved_quantity: '10000.000' }]);
  });

  it('RET-003, RET-008, OQ-020: defective and paid for — the credit settles the store\'s other debts first; the rest is cash back from the seller', async () => {
    const { seller, sale, line, batchId, bag, store } = await aSale({ sold: 2 });
    await recordPayment(seller.ctx, { storeId: store.id, amount: '180.00', method: 'CASH' });
    await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] });     // another sale, still owed: 90.00
    expect(await cashInHand(getDb(), seller.account.id)).toBe('180.00');
    const credit = await recordReturn(seller.ctx, { saleId: sale.id, kind: 'CREDIT_NOTE', condition: 'DEFECTIVE', lines: [{ saleLineId: line.id, batchId, packs: 2 }] });
    expect(credit).toMatchObject({ amount: '180.00', toSale: '0.00', toOtherDebts: '90.00', refund: '90.00', collectedPortion: '180.00' });
    expect(credit.lines).toMatchObject([{ outcome: 'WRITE_OFF', packs: 2 }]);
    expect(await cashInHand(getDb(), seller.account.id)).toBe('90.00');
    expect((await getCreditStatus(seller.ctx, store.id)).outstanding).toBe('0.00');
    expect(await ownerQuery("select entry_type, amount from cash_ledger_entries where reference_id = $1", [credit.id])).toEqual([{ entry_type: 'REFUND', amount: '-90.00' }]);
  });

  it('OQ-020: a refund beyond the seller\'s cash in hand is refused — nothing moves', async () => {
    const { seller, sale, line, batchId } = await aSale({ sold: 1, creditMode: 'BILL_TO_BILL', creditLimit: '0.00', payment: { method: 'BANK_TRANSFER', reference: 'TRX-1' } });
    const before = await vehiclePacks(seller.ctx);
    expect(await code(recordReturn(seller.ctx, { saleId: sale.id, kind: 'CREDIT_NOTE', condition: 'DEFECTIVE', lines: [{ saleLineId: line.id, batchId, packs: 1 }] })))
      .toBe('REFUND_EXCEEDS_CASH_IN_HAND');
    expect(await vehiclePacks(seller.ctx)).toBe(before);
    expect((await listReturns(seller.ctx, { saleId: sale.id })).items).toEqual([]);
  });

  it('RET-008: a line returned in parts is credited to exactly its total, discount included', async () => {
    const { seller, store, bag, admin: ctx } = await aSale({ sold: 1 });
    await setPriceListItems(ctx, await basePriceListId(), [{ skuId: bag.id, price: '11.11' }]);
    const sale = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 3, discount: '5' }] });
    const line = sale.lines[0];
    const batchId = line?.batches[0]?.batchId ?? '';
    expect(line?.total).toBe('31.66');
    const parts: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      parts.push((await recordReturn(seller.ctx, { saleId: sale.id, kind: 'CREDIT_NOTE', condition: 'UNCLEARED_PAYMENT', lines: [{ saleLineId: line?.id ?? '', batchId, packs: 1 }] })).amount);
    }
    expect(parts).toEqual(['10.55', '10.56', '10.55']);
  });
});

describe('the defective replacement (RET-010..012, WRO-007)', () => {
  it('RET-010, RET-011, RET-012, WRO-007: stock for stock from the vehicle — the defective bag written off, no money moves, the sale unchanged', async () => {
    const { seller, sale, line, batchId, store } = await aSale({ sold: 3 });
    expect(await code(recordReturn(seller.ctx, { saleId: sale.id, kind: 'REPLACEMENT', condition: 'UNCLEARED_PAYMENT', lines: [{ saleLineId: line.id, batchId, packs: 1 }] })))
      .toBe('REPLACEMENT_ONLY_DEFECTIVE');
    const swap = await recordReturn(seller.ctx, { saleId: sale.id, kind: 'REPLACEMENT', condition: 'DEFECTIVE', lines: [{ saleLineId: line.id, batchId, packs: 1 }] });
    expect(swap).toMatchObject({
      number: `RP-${year}-000001`, kind: 'REPLACEMENT', amount: '0.00', refund: '0.00',
      lines: [{ packs: 1, outcome: 'WRITE_OFF', amount: '0.00', batch: { batchId }, replacements: [{ batchId, packs: 1 }] }],
    });
    expect(await vehiclePacks(seller.ctx)).toBe(6);
    expect(await movements(swap.id)).toEqual([
      { batch_id: batchId, account_kind: 'SOLD', quantity: '-5000.000' }, { batch_id: batchId, account_kind: 'SOLD', quantity: '5000.000' },
      { batch_id: batchId, account_kind: 'VEHICLE', quantity: '-5000.000' }, { batch_id: batchId, account_kind: 'WRITTEN_OFF', quantity: '5000.000' },
    ]);
    expect(await ownerQuery('select status, reason from write_offs where return_id = $1', [swap.id])).toEqual([{ status: 'APPROVED', reason: 'DEFECTIVE' }]);
    expect((await listStoreLedger(seller.ctx, store.id)).map((e) => e.entryType)).toEqual(['SALE']);
    expect((await mySalesMonth(seller.ctx)).net).toBe('270.00');
    // The store still holds three bags from the sale — the replacement among them.
    expect((await getReturnable(seller.ctx, sale.id)).lines[0]?.batches).toMatchObject([{ batchId, packs: 3 }]);
  });
});

describe('recorded sales and the console (RET-009, workflow L)', () => {
  it('RET-009: a credit note reduces the seller\'s recorded sales in the month it is raised', async () => {
    const { seller, sale, line, batchId } = await aSale();
    expect(await mySalesMonth(seller.ctx)).toMatchObject({ sold: '360.00', sales: 1, returned: '0.00', creditNotes: 0, net: '360.00' });
    await recordReturn(seller.ctx, { saleId: sale.id, kind: 'CREDIT_NOTE', condition: 'UNCLEARED_PAYMENT', lines: [{ saleLineId: line.id, batchId, packs: 1 }] });
    expect(await mySalesMonth(seller.ctx)).toMatchObject({ sold: '360.00', returned: '90.00', creditNotes: 1, net: '270.00' });
    const other = await ctxFor(await anAccount('SELLER'));
    expect(await code(mySalesMonth(other, { sellerId: seller.account.id }))).toBe('FORBIDDEN');
  });

  it('RET-007: a manager records a credit note in the console — goods to a warehouse; a replacement or a cash refund needs the seller', async () => {
    const { seller, sale, line, batchId, admin: ctx } = await aSale({ sold: 2 });
    const view = await getReturnable(ctx, sale.id);
    if (view.place.kind !== 'WAREHOUSE') throw new Error('expected the console');
    const warehouseId = view.place.warehouses[0]?.id ?? '';
    const credit = await recordReturn(ctx, { saleId: sale.id, kind: 'CREDIT_NOTE', condition: 'UNCLEARED_PAYMENT', warehouseId, lines: [{ saleLineId: line.id, batchId, packs: 1 }] });
    expect(credit).toMatchObject({ vehicle: null, warehouse: { id: warehouseId }, seller: { id: seller.account.id }, processedBy: { id: ctx.user.id } });
    expect(await movements(credit.id)).toEqual([
      { batch_id: batchId, account_kind: 'SOLD', quantity: '-5000.000' }, { batch_id: batchId, account_kind: 'WAREHOUSE', quantity: '5000.000' },
    ]);
    expect(await code(recordReturn(ctx, { saleId: sale.id, kind: 'REPLACEMENT', condition: 'DEFECTIVE', lines: [{ saleLineId: line.id, batchId, packs: 1 }] })))
      .toBe('REPLACEMENT_NEEDS_VEHICLE');
    await recordPayment(seller.ctx, { storeId: sale.store.id, amount: '90.00', method: 'CASH' });
    expect(await code(recordReturn(ctx, { saleId: sale.id, kind: 'CREDIT_NOTE', condition: 'DEFECTIVE', lines: [{ saleLineId: line.id, batchId, packs: 1 }] })))
      .toBe('REFUND_NEEDS_SELLER');
    // The seller sees the return on their sale.
    expect((await listReturns(seller.ctx, { saleId: sale.id })).items).toMatchObject([{ id: credit.id, number: credit.number, packs: 1 }]);
  });
});

describe('a dispatch disputed after a remote confirmation (OQ-012)', () => {
  it('OQ-012: a manager credits the store, the goods are written off, and the seller hands the money over later', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    // The store paid on receipt, confirmed on its owner's word — then says nothing arrived.
    const { orderId } = await raiseDispatchOrder(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2 }] });
    const released = await releaseOrder(ctx, orderId ?? '', { version: 1, transportSlipPhotoId: await aPhoto(ctx, 'TRANSPORT_SLIP') });
    const confirmed = await confirmReceipt(seller.ctx, released.id, {
      version: released.version, mode: 'OWNER_WORD', payment: { method: 'CASH' },
      lines: released.lines.map((l) => ({ lineId: l.id, received: l.packs, short: 0, damaged: 0 })),
    });
    const saleId = confirmed.sale.id;
    const line = (await getReturnable(ctx, saleId)).lines[0];
    const batchId = line?.batches[0]?.batchId ?? '';

    // Only a manager, and only because it was confirmed remotely.
    expect((await getReturnable(seller.ctx, saleId)).conditions.map((c) => c.condition)).not.toContain('NOT_RECEIVED');
    expect((await getReturnable(ctx, saleId)).conditions.map((c) => c.condition)).toContain('NOT_RECEIVED');
    const credit = await recordReturn(ctx, {
      saleId, kind: 'CREDIT_NOTE', condition: 'NOT_RECEIVED', note: 'Store says nothing came; transporter says delivered',
      lines: [{ saleLineId: line?.saleLineId ?? '', batchId, packs: 2 }],
    });
    expect(credit).toMatchObject({ condition: 'NOT_RECEIVED', amount: '180.00', refund: '0.00', lines: [{ outcome: 'WRITE_OFF' }] });
    expect(await ownerQuery('select reason from write_offs where return_id = $1', [credit.id])).toEqual([{ reason: 'MISSING' }]);
    expect(await cashInHand(getDb(), seller.account.id)).toBe('180.00'); // the manager holds no cash to refund with

    // The seller hands it over on a later visit, out of their cash in hand.
    expect(await myRefundsDue(seller.ctx)).toMatchObject([{ number: credit.number, outstanding: '180.00', store: { id: store.id } }]);
    expect(await payRefundDue(seller.ctx, credit.id)).toEqual([]);
    expect(await cashInHand(getDb(), seller.account.id)).toBe('0.00');
    expect(await code(payRefundDue(seller.ctx, credit.id))).toBe('ALREADY_DECIDED');
  });
});
