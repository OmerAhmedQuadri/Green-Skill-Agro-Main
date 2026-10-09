import { businessDate, businessMonth, type DomainError, type PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { aPdfRenderer, aSellingSeller, paid } from '../../test/sales';
import { YARD } from '../../test/vehicles';
import { cashInHand } from '../cash';
import type { Ctx } from '../context';
import { listMyNotifications, waitingForDecision } from '../notifications';
import { salesAnalytics } from '../reports';
import { getReturnable } from '../returns';
import { getDb } from '../runtime';
import { decideTransfer } from '../stores';
import { updateSettings } from '../system';
import { actualsFor } from '../targets';
import {
  completeSale, decideDiscountRequest, expireDiscountRequests, getSale, listSales, openSaleOptions, recordOpenSale, recordSale, renderPendingDocuments,
} from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async () => ctxFor(await anAccount('ADMIN'));
const manager = async (grants: PermissionCode[]) => ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });
const HERE = { lat: YARD.lat + 0.01, lng: YARD.lng, accuracyM: 12 };
const kinds = async (ctx: Ctx) => (await listMyNotifications(ctx, { limit: 50 })).items.map((n) => n.kind);
const year = new Date().toISOString().slice(0, 4);

/** A checked-in seller with ten bags of okra (90.00 each on the base list) on the vehicle, and the admin who set it up. */
async function anOpenSeller() {
  const ctx = await admin();
  const setup = await aSellingSeller(ctx);
  const sell = async (packs: number, extra: Partial<Parameters<typeof recordOpenSale>[1]> = {}) => recordOpenSale(setup.seller.ctx, {
    lines: [{ skuId: setup.bag.id, packs }], location: HERE, ...extra,
  });
  return { ...setup, admin: ctx, sell };
}

describe('open sales (ADR-0052)', () => {
  it('SAL-012, SAL-013, SAL-017: switched on and within the limit, it completes paid in full — no store, nothing on any ledger, a simplified record', async () => {
    const { seller, sell } = await anOpenSeller();
    const options = await openSaleOptions(seller.ctx);
    expect(options).toMatchObject({ notWorking: null, openSales: { switchedOn: true, limit: '500.00' } });
    expect(options.items[0]).toMatchObject({ unitPrice: '90.00', sellablePacks: 10 });

    const sale = await sell(2, { buyer: { name: '  Abu Khalid ', phone: '050 765 4321' }, payment: await paid(seller.ctx, '180.00') });
    expect(sale).toMatchObject({
      status: 'COMPLETED', store: null, total: '180.00',
      open: { buyerName: 'Abu Khalid', buyerPhone: '+966507654321', location: { lat: HERE.lat, lng: HERE.lng, accuracyM: 12 } },
      payment: { method: 'CASH', amount: '180.00' }, document: { number: `OS-${year}-000001` },
    });
    // Nothing on any store's ledger; the cash is in the seller's hands.
    expect(await ownerQuery("select 1 from store_ledger_entries where reference_id = $1", [sale.id])).toEqual([]);
    expect(await ownerQuery<{ store_id: string | null; ledger_entry_id: string | null }>('select store_id, ledger_entry_id from payments where id = $1', [sale.payment?.id]))
      .toEqual([{ store_id: null, ledger_entry_id: null }]);
    expect(await cashInHand(getDb(), seller.account.id)).toBe('180.00');
    expect((await openSaleOptions(seller.ctx)).items[0]?.sellablePacks).toBe(8);

    // SAL-017: the paper is a simplified delivery record, marked, with the buyer and no store.
    const printer = aPdfRenderer();
    await renderPendingDocuments(printer, new Date());
    const html = printer.printed.find((h) => h.includes(`OS-${year}-000001`)) ?? '';
    expect(html).toContain('Simplified delivery record');
    expect(html).toContain('This is not a tax invoice');
    expect(html).toContain('Abu Khalid');
    expect(html).not.toContain('>Store<');
  });

  it('SAL-012: the buyer may say nothing; the place is always kept', async () => {
    const { seller, sell } = await anOpenSeller();
    const sale = await sell(1, { payment: await paid(seller.ctx, '90.00') });
    expect(sale.open).toMatchObject({ buyerName: null, buyerPhone: null, location: { lat: HERE.lat } });
    expect(await code(recordOpenSale(seller.ctx, { lines: [{ skuId: sale.lines[0]?.skuId ?? '', packs: 1 }], location: { lat: 200, lng: 0 } }))).toBe('LOCATION_REQUIRED');
  });

  it('SAL-013: paid in full, exactly — not later, not in part, not more', async () => {
    const { seller, sell } = await anOpenSeller();
    expect(await code(sell(2))).toBe('OPEN_SALE_PAID_IN_FULL');
    expect(await code(sell(2, { payment: await paid(seller.ctx, '100.00') }))).toBe('OPEN_SALE_PAID_IN_FULL');
    expect(await code(sell(2, { payment: await paid(seller.ctx, '200.00') }))).toBe('OPEN_SALE_PAID_IN_FULL');
    expect((await openSaleOptions(seller.ctx)).items[0]?.sellablePacks).toBe(10); // nothing moved
  });

  it('SAL-013: by bank transfer — an approver confirms it; never received, the seller is told and no store owes it', async () => {
    const { admin: ctx, seller, sell } = await anOpenSeller();
    const confirmed = await sell(1, { payment: await paid(seller.ctx, '90.00', 'BANK_TRANSFER', 'TRX-OPEN-1') });
    expect(await kinds(ctx)).toContain('TRANSFER_RECORDED');
    await decideTransfer(ctx, confirmed.payment?.id ?? '', { outcome: 'CONFIRMED' });

    const lost = await sell(1, { payment: await paid(seller.ctx, '90.00', 'BANK_TRANSFER', 'TRX-OPEN-2') });
    await decideTransfer(ctx, lost.payment?.id ?? '', { outcome: 'NOT_RECEIVED', reason: 'Not on the statement' });
    const told = (await listMyNotifications(seller.ctx, { limit: 50 })).items.find((n) => n.kind === 'TRANSFER_NOT_RECEIVED');
    expect(told?.link).toBe(`/field/sales/${lost.id}`);
    expect(await ownerQuery("select 1 from store_ledger_entries where reference_type = 'TRANSFER_NOT_RECEIVED'")).toEqual([]);
  });

  it('SAL-014: priced from the base list, with discounts within the ceiling only — never a request for more', async () => {
    const { seller, sell } = await anOpenSeller();
    const within = await sell(1, { lines: [{ skuId: (await openSaleOptions(seller.ctx)).items[0]?.skuId ?? '', packs: 1, discount: '5' }], payment: await paid(seller.ctx, '85.50') });
    expect(within).toMatchObject({ status: 'COMPLETED', total: '85.50' });
    const skuId = within.lines[0]?.skuId ?? '';
    const above = await recordOpenSale(seller.ctx, { lines: [{ skuId, packs: 1, discount: '12' }], location: HERE, approvalReason: 'A good customer' }).catch((e: DomainError) => e);
    expect(above).toMatchObject({ code: 'DISCOUNT_ABOVE_CEILING', details: { open: true } });
  });

  it('SAL-015, SAL-016: switched off, it waits for an approver of open sales; approved, the seller completes it paid in full', async () => {
    const { admin: ctx, seller, sell } = await anOpenSeller();
    const approver = await admin();
    await updateSettings(ctx, [{ key: 'sales.open_sales_on', value: false }]);
    expect((await openSaleOptions(seller.ctx)).openSales.switchedOn).toBe(false);
    expect(await code(sell(2, { payment: await paid(seller.ctx, '180.00') }))).toBe('OPEN_SALE_NEEDS_APPROVAL');
    // Waiting, it takes no money yet — as a discount request.
    expect(await code(sell(2, { payment: await paid(seller.ctx, '180.00'), approvalReason: 'Farmer passing by' }))).toBe('INVALID_TRANSITION');

    const pending = await sell(2, { approvalReason: 'Farmer passing by', buyer: { name: 'Abu Salem' } });
    expect(pending).toMatchObject({ status: 'PENDING_DISCOUNT_APPROVAL', approval: { kind: 'OPEN_SALE', grounds: ['SWITCHED_OFF'], status: 'PENDING' }, payment: null });
    expect((await openSaleOptions(seller.ctx)).items[0]?.sellablePacks).toBe(8); // held
    expect(await kinds(approver)).toContain('OPEN_SALE_REQUESTED');
    expect((await waitingForDecision(approver)).find((q) => q.queue === 'OPEN_SALES')?.count).toBe(1);

    // Whoever approves discounts only has no say over it, nor sight of it.
    const discountsOnly = await manager(['sales.approve_discount']);
    expect(await code(decideDiscountRequest(discountsOnly, pending.id, { version: pending.version, approve: true }))).toBe('FORBIDDEN');
    expect((await listSales(discountsOnly, { awaitingDecision: true })).items.map((s) => s.id)).not.toContain(pending.id);
    const openOnly = await manager(['sales.approve_open_sale']);
    expect((await listSales(openOnly, { awaitingDecision: true })).items.map((s) => s.id)).toContain(pending.id);

    // Approved as it stands — never lower — and the seller is told.
    expect(await code(decideDiscountRequest(approver, pending.id, { version: pending.version, approve: true, lines: [{ lineId: pending.lines[0]?.id ?? '', discount: '0' }] })))
      .toBe('INVALID_TRANSITION');
    const approved = await decideDiscountRequest(approver, pending.id, { version: pending.version, approve: true });
    expect(approved).toMatchObject({ status: 'DISCOUNT_APPROVED', approval: { kind: 'OPEN_SALE', status: 'APPROVED', decidedBy: { id: approver.user.id } } });
    expect(await kinds(seller.ctx)).toContain('OPEN_SALE_APPROVED');
    expect((await listMyNotifications(ctx, { limit: 50 })).items.find((n) => n.kind === 'OPEN_SALE_REQUESTED')?.resolution)
      .toMatchObject({ outcome: 'APPROVED', by: { id: approver.user.id } });

    // SAL-013: completing it takes the whole total.
    expect(await code(completeSale(seller.ctx, pending.id, { version: approved.version }))).toBe('OPEN_SALE_PAID_IN_FULL');
    const done = await completeSale(seller.ctx, pending.id, { version: approved.version, payment: await paid(seller.ctx, '180.00') });
    expect(done).toMatchObject({ status: 'COMPLETED', store: null, payment: { amount: '180.00' }, document: { number: `OS-${year}-000001` } });
    expect(await cashInHand(getDb(), seller.account.id)).toBe('180.00');
  });

  it('SAL-016: rejected with a comment, it closes and frees what it held; above the limit, it waits even when switched on', async () => {
    const { admin: ctx, seller, sell } = await anOpenSeller();
    await updateSettings(ctx, [{ key: 'sales.open_sale_limit', value: '150.00' }]);
    expect(await code(sell(2, { payment: await paid(seller.ctx, '180.00') }))).toBe('OPEN_SALE_NEEDS_APPROVAL');
    const pending = await sell(2, { approvalReason: 'Big order' });
    expect(pending.approval).toMatchObject({ kind: 'OPEN_SALE', grounds: ['ABOVE_LIMIT'] });
    expect(await code(decideDiscountRequest(ctx, pending.id, { version: pending.version, approve: false }))).toBe('REASON_REQUIRED');
    const rejected = await decideDiscountRequest(ctx, pending.id, { version: pending.version, approve: false, comment: 'Sell it to a store' });
    expect(rejected).toMatchObject({ status: 'CANCELLED', cancelReason: 'REJECTED' });
    expect(await kinds(seller.ctx)).toContain('OPEN_SALE_REJECTED');
    expect((await openSaleOptions(seller.ctx)).items[0]?.sellablePacks).toBe(10);
    // Within the limit, it goes straight through.
    expect((await sell(1, { payment: await paid(seller.ctx, '90.00') })).status).toBe('COMPLETED');
  });

  it('SAL-016: a waiting open sale expires, and the seller is told in its own words', async () => {
    const { admin: ctx, seller, sell } = await anOpenSeller();
    await updateSettings(ctx, [{ key: 'sales.open_sales_on', value: false }]);
    const pending = await sell(1, { approvalReason: 'Passing buyer' });
    expect(await expireDiscountRequests(new Date(Date.now() + 2 * 3_600_000))).toEqual({ expired: 1 });
    expect(await getSale(seller.ctx, pending.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'EXPIRED', approval: { status: 'EXPIRED' } });
    expect(await kinds(seller.ctx)).toContain('OPEN_SALE_EXPIRED');
    expect((await listMyNotifications(ctx, { limit: 50 })).items.find((n) => n.kind === 'OPEN_SALE_REQUESTED')?.resolution).toMatchObject({ outcome: 'EXPIRED' });
  });

  it('SAL-015: the switch is the Admin\'s, and a manager\'s only if granted; the limit stays the Admin\'s', async () => {
    const granted = await manager(['sales.manage_open_sales']);
    const notGranted = await manager([]);
    await updateSettings(granted, [{ key: 'sales.open_sales_on', value: false }]);
    expect(await code(updateSettings(notGranted, [{ key: 'sales.open_sales_on', value: true }]))).toBe('FORBIDDEN');
    expect(await code(updateSettings(granted, [{ key: 'sales.open_sale_limit', value: '900.00' }]))).toBe('FORBIDDEN');
    expect(await code(updateSettings(await admin(), [{ key: 'sales.open_sale_limit', value: 900 }]))).toBe('INVALID_SETTING'); // money travels as a string
  });

  it('SAL-018: an open sale is never returned', async () => {
    const { admin: ctx, seller, sell } = await anOpenSeller();
    const sale = await sell(1, { payment: await paid(seller.ctx, '90.00') });
    expect(await code(getReturnable(ctx, sale.id))).toBe('OPEN_SALE_NOT_RETURNABLE');
  });

  it('SAL-019: it counts in the seller\'s sales and targets, shows as an open sale in lists, and is one line of its own in analytics', async () => {
    const { admin: ctx, seller, store, bag, sell } = await anOpenSeller();
    await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] });
    const open = await sell(2, { buyer: { name: 'Abu Khalid' }, payment: await paid(seller.ctx, '180.00') });
    expect((await actualsFor(getDb(), seller.account.id, businessMonth(new Date()))).REVENUE).toBe('270.00');
    expect((await listSales(seller.ctx, {})).items.find((s) => s.id === open.id)).toMatchObject({ store: null, open: true, buyerName: 'Abu Khalid' });
    expect((await listSales(ctx, { open: true })).items.map((s) => s.id)).toEqual([open.id]);
    const today = businessDate(new Date());
    const byStore = (await salesAnalytics(ctx, { from: today, to: today })).byStore;
    expect(byStore.find((r) => r.id === 'OPEN')).toMatchObject({ sold: '180.00', sales: 1 });
    expect(byStore.find((r) => r.id === store.id)).toMatchObject({ sold: '90.00' });
  });
});
