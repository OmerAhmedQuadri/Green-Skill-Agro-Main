import { addDays, businessDate, businessMonth, presetOverrides, PRESET_DEFAULTS, type DomainError } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { anOrderInTransit } from '../../test/procurement';
import { aSellingSeller, paid } from '../../test/sales';
import { okraInWarehouse } from '../../test/stock';
import { aStore } from '../../test/stores';
import { aSeller } from '../../test/vehicles';
import { raiseDispatchOrder, releaseOrder } from '../dispatch';
import { recordSale } from '../sales';
import { adjustBalance, decideStore, recordPayment } from '../stores';
import { setTarget } from '../targets';
import { dashboardMoney, dashboardOptions, dashboardSales, dashboardStock, dashboardStores, dashboardTeam } from './dashboard';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async () => ctxFor(await anAccount('ADMIN'));
const today = businessDate(new Date());
const monthStart = `${today.slice(0, 7)}-01`;
const thisMonth = { from: monthStart, to: today };
/** Moves a sale back in time, as far as the figures know. */
const backdate = (saleId: string, interval: string) =>
  ownerQuery(`update sales set completed_at = completed_at - interval '${interval}', created_at = created_at - interval '${interval}' where id = $1`, [saleId]);

describe('the dashboard (ADR-0054)', () => {
  it('RPT-012: the sales tab — the period against the same days of last month, every filter of the analytics, the latest sales', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx, { creditLimit: '100000.00' });
    const first = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 3 }] }); // 270.00
    const second = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2 }] }); // 180.00
    const earlier = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] }); // 90.00 —
    await backdate(earlier.id, '1 month'); // — made, as far as the figures know, this day last month.

    const tab = await dashboardSales(ctx, thisMonth);
    expect(tab.totals).toMatchObject({ net: '450.00', sales: 2, average: '225.00' });
    expect(tab.previous).toMatchObject({ totals: { net: '90.00', sales: 1 } });
    expect(tab.previous.from).toBe(`${addDays(monthStart, -1).slice(0, 7)}-01`);
    expect(tab.change).toBe('400.0');
    expect(tab.bySeller).toMatchObject([{ id: seller.account.id, net: '450.00' }]);
    expect(tab.latest?.map((s) => s.id)).toEqual([second.id, first.id]);
    // Another seller's month: nothing, against nothing.
    const other = await aSeller();
    expect(await dashboardSales(ctx, { ...thisMonth, sellerId: other.account.id })).toMatchObject({ totals: { net: '0.00', sales: 0 }, change: null, latest: [] });
  });

  it('RPT-013: the team on a day — who is working, their sales, what they carry, their target and the month\'s commission; another day without the carrying', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx, { creditLimit: '100000.00' });
    const idle = await aSeller();
    await setTarget(ctx, { sellerId: seller.account.id, period: businessMonth(new Date()), goals: { REVENUE: '1000.00' } });
    await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2 }], payment: await paid(seller.ctx, '180.00') });

    const tab = await dashboardTeam(ctx);
    expect(tab).toMatchObject({ date: today, today: true, columns: { status: true, sales: true, carrying: true, target: true } });
    expect(tab.rows.map((r) => r.seller.id)).toEqual([seller.account.id, idle.account.id]);
    // Eight bags left on the vehicle, at the base price of 90.00.
    expect(tab.rows[0]).toMatchObject({
      status: 'WORKING', sales: { net: '180.00', count: 1 }, cash: { inHand: '180.00', over: false }, stock: { value: '720.00' }, target: { achievement: '18.0' },
    });
    expect(tab.rows[1]).toMatchObject({ status: 'NOT_IN', since: null, sales: { net: '0.00', count: 0 }, target: null });
    expect(tab.counts).toEqual({ WORKING: 1, ON_BREAK: 0, AWAITING: 0, DONE: 0, NOT_IN: 1 });
    expect(tab.totals).toMatchObject({ sales: '180.00', cash: '180.00', stock: '720.00', commission: { final: false } });

    // Yesterday: nobody was in, nothing sold, and what they carry is today's figure, so not shown.
    const yesterday = await dashboardTeam(ctx, { date: addDays(today, -1) });
    expect(yesterday).toMatchObject({ today: false, columns: { carrying: false }, totals: { sales: '0.00', cash: null } });
    expect(yesterday.rows.every((r) => r.status === 'NOT_IN' && r.cash === null)).toBe(true);
    expect(await code(dashboardTeam(ctx, { date: addDays(today, 1) }))).toBe('INVALID_DATE');
  });

  it('RPT-016: the stores tab — the kinds, the stores gone quiet for the chosen days (one never served once it is that old), and the new', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx, { creditLimit: '100000.00' });
    const approved = async () => { const s = await aStore(seller.ctx); return decideStore(ctx, s.id, 'approve', { version: s.version }); };
    const lapsed = await approved();
    const neverServed = await approved();
    const brandNew = await approved(); // never served either, but only today: not quiet yet
    await aStore(seller.ctx); // waiting for approval
    await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] }); // bought today
    await backdate((await recordSale(seller.ctx, { storeId: lapsed.id, lines: [{ skuId: bag.id, packs: 1 }] })).id, '40 days');
    await ownerQuery("update stores set created_at = created_at - interval '70 days' where id = $1", [neverServed.id]);

    const tab = await dashboardStores(ctx, { ...thisMonth, quietDays: 30 });
    expect(tab.counts).toEqual({ active: 4, pending: 1, inactive: 0, blocked: 0 });
    expect(tab.quiet.stores.map((q) => q.store.id)).not.toContain(brandNew.id);
    // Longest quiet first; the store never served after them.
    expect(tab.quiet).toMatchObject({ days: 30, count: 2, stores: [{ store: { id: lapsed.id }, days: 40, seller: { id: seller.account.id } }, { store: { id: neverServed.id }, lastSale: null, days: null }] });
    expect(tab.quiet.stores[0]?.lastSale).toBe(addDays(today, -40));
    expect((await dashboardStores(ctx, { ...thisMonth, quietDays: 60 })).quiet.stores.map((q) => q.store.id)).toEqual([neverServed.id]);
    // New this month: all but the one onboarded seventy days ago.
    expect(tab.fresh).toMatchObject({ count: 4 });
    expect(tab.fresh.stores.map((s) => s.store.id)).not.toContain(neverServed.id);
    // Another seller's stores: none.
    const other = await aSeller();
    expect((await dashboardStores(ctx, { ...thisMonth, quietDays: 30, sellerId: other.account.id })).counts).toEqual({ active: 0, pending: 0, inactive: 0, blocked: 0 });
  });

  it('RPT-014: the money tab — owed and how late, the stores most overdue, the blocked, collections, and the money in motion', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx, { creditLimit: '100000.00' });
    await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2 }] }); // 180.00, due at the week's close
    await adjustBalance(ctx, store.id, { amount: '300.00', reason: 'Opening balance', dueOn: addDays(today, -45) });
    // Oldest first (CRD-003): both go to the overdue balance. The transfer waits for an approver (ADR-0046).
    await recordPayment(seller.ctx, { storeId: store.id, ...(await paid(seller.ctx, '100.00')) });
    await recordPayment(seller.ctx, { storeId: store.id, ...(await paid(seller.ctx, '50.00', 'BANK_TRANSFER', 'TRX-DASH-1')) });

    const tab = await dashboardMoney(ctx, thisMonth);
    expect(tab.owed).toMatchObject({
      aged: { NOT_DUE: '180.00', DAYS_31_60: '150.00', total: '330.00' }, overdue: '150.00', owing: 1, blocked: 1,
      mostOverdue: [{ store: { id: store.id }, seller: { id: seller.account.id }, overdue: '150.00', total: '330.00', worst: 'DAYS_31_60' }],
    });
    expect(tab.collected).toMatchObject({ cash: '100.00', bank: '50.00', total: '150.00', payments: 2 });
    expect(tab.motion).toEqual({
      withSellers: { amount: '100.00', sellers: 1, over: 0 }, settlements: { count: 0, amount: '0.00' }, transfers: { count: 1, amount: '50.00' },
    });
    // One store that owes nothing: none of it.
    const other = await aSeller();
    expect(await dashboardMoney(ctx, { ...thisMonth, sellerId: other.account.id })).toMatchObject({
      owed: { owing: 0, blocked: 0, mostOverdue: [] }, collected: { total: '0.00' }, motion: { withSellers: { amount: '0.00' }, transfers: { count: 0 } },
    });
  });

  it('RPT-015: the stock tab — flagged for expiry, to order, due in (narrowed to a product), what each vehicle carries, and dispatches on the road', async () => {
    const ctx = await admin();
    const { seller, store, bag, vehicle } = await aSellingSeller(ctx, { creditLimit: '100000.00' }); // ten bags on the vehicle, expiring in two years
    const soon = addDays(today, 60);
    const expiring = await okraInWarehouse(ctx, { expiresOn: soon }); // 20 bags and 10 pouches, inside the 90-day warning
    const due = await anOrderInTransit(ctx, { expectedArrival: addDays(today, -3) });
    const { orderId } = await raiseDispatchOrder(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2 }] });
    const order = await releaseOrder(ctx, orderId ?? '', { version: 1, transportSlipPhotoId: await aPhoto(ctx, 'TRANSPORT_SLIP') });

    const tab = await dashboardStock(ctx);
    expect(tab.expiring).toMatchObject({ batches: 2, packs: 30 });
    expect(tab.expiring?.soonest[0]).toMatchObject({ expiresOn: soon, daysLeft: 60, time: true });
    expect(tab.incoming).toMatchObject({ orders: 1, late: 1, next: [{ poId: due.po.id, packs: 30, lines: 2 }] });
    expect(tab.reorder?.items).toBe(tab.reorder?.top.length);
    expect(tab.vehicles).toMatchObject({ loaded: 1, packs: 10, value: '900.00', list: [{ id: vehicle.id, seller: { id: seller.account.id }, packs: 10, value: '900.00' }] });
    expect(tab.dispatch).toMatchObject({ requested: 0, onTheRoad: 1, unconfirmed: 0, value: '180.00', oldest: [{ id: order.id }] });

    // Narrowed to the expiring okra's product: its batches and its order stay; the vehicle and the dispatch are whole loads, never narrowed.
    const narrowed = await dashboardStock(ctx, { productId: expiring.product.id });
    expect(narrowed.expiring?.batches).toBe(2);
    expect(narrowed.incoming?.orders).toBe(0);
    expect(narrowed.vehicles?.loaded).toBe(1);
    expect((await dashboardStock(ctx, { productId: due.product.id })).expiring?.batches).toBe(0);
  });

  it('ADR-0054: each tab for those allowed its figures — the warehouse stock alone; a sales manager all five, less reordering and targets; a seller none', async () => {
    const warehouse = await ctxFor(await anAccount('MANAGER'), { overrides: presetOverrides(PRESET_DEFAULTS.WAREHOUSE) });
    expect((await dashboardOptions(warehouse)).tabs).toEqual(['stock']);
    for (const tab of [dashboardSales(warehouse, thisMonth), dashboardTeam(warehouse), dashboardStores(warehouse, { ...thisMonth, quietDays: 30 }), dashboardMoney(warehouse, thisMonth)]) {
      expect(await code(tab)).toBe('FORBIDDEN');
    }
    expect(await dashboardStock(warehouse)).toMatchObject({ reorder: null, expiring: { batches: 0 }, incoming: { orders: 0 }, vehicles: { loaded: 0 }, dispatch: { onTheRoad: 0 } });

    const sales = await ctxFor(await anAccount('MANAGER'), { overrides: presetOverrides(PRESET_DEFAULTS.SALES_MANAGER) });
    expect((await dashboardOptions(sales)).tabs).toEqual(['sales', 'team', 'stores', 'money', 'stock']);
    expect((await dashboardTeam(sales)).columns).toEqual({ status: true, sales: true, carrying: true, target: false });
    expect((await dashboardMoney(sales, thisMonth)).motion?.transfers).not.toBeNull();
    expect((await dashboardStock(sales)).reorder).toBeNull();

    const seller = await aSeller();
    expect(await code(dashboardOptions(seller.ctx))).toBe('FORBIDDEN');
  });
});
