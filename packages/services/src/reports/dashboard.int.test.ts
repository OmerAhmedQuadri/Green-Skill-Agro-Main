import { addDays, businessDate, businessMonth, presetOverrides, PRESET_DEFAULTS } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { anOrderInTransit } from '../../test/procurement';
import { aSellingSeller, paid } from '../../test/sales';
import { okraInWarehouse } from '../../test/stock';
import { aSeller } from '../../test/vehicles';
import { recordSale } from '../sales';
import { adjustBalance, recordPayment } from '../stores';
import { setTarget } from '../targets';
import { getDashboard } from './dashboard';

const admin = async () => ctxFor(await anAccount('ADMIN'));
const today = businessDate(new Date());

describe('the dashboard (ADR-0054)', () => {
  it('RPT-012: sales at a glance — today, this month against the same days of last month, thirty days, who and what sold most, the latest sales', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx, { creditLimit: '100000.00' });
    const first = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 3 }] }); // 270.00
    const second = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2 }] }); // 180.00
    const earlier = await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] }); // 90.00 —
    // — made, as far as the figures know, on this day last month.
    await ownerQuery("update sales set completed_at = completed_at - interval '1 month', created_at = created_at - interval '1 month' where id = $1", [earlier.id]);

    const { sales } = await getDashboard(ctx);
    expect(sales).toMatchObject({
      today: { net: '450.00', sales: 2, packs: 5 },
      month: { net: '450.00', sales: 2, average: '225.00' },
      lastMonth: { net: '90.00', sales: 1 },
      change: '400.0',
      topSellers: [{ id: seller.account.id, net: '450.00' }],
      topProducts: [{ net: '450.00', label: { nameEn: 'Okra', nameAr: 'بامية' } }],
    });
    expect(sales?.series).toHaveLength(30);
    expect(sales?.series[0]?.period).toBe(addDays(today, -29));
    expect(sales?.series.at(-1)).toEqual({ period: today, net: '450.00', sales: 2 });
    expect(sales?.recent?.map((s) => s.id)).toEqual([second.id, first.id, earlier.id]);
  });

  it('RPT-013: the team today — who is working and who is not in, their sales today, their cash against the ceiling, their target', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx, { creditLimit: '100000.00' });
    const idle = await aSeller();
    await setTarget(ctx, { sellerId: seller.account.id, period: businessMonth(new Date()), goals: { REVENUE: '1000.00' } });
    await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2 }], payment: await paid(seller.ctx, '180.00') });

    const { team } = await getDashboard(ctx);
    expect(team?.columns).toEqual({ status: true, sales: true, cash: true, target: true });
    // Working first, then whoever is not in.
    expect(team?.rows.map((r) => r.seller.id)).toEqual([seller.account.id, idle.account.id]);
    expect(team?.rows[0]).toMatchObject({
      status: 'WORKING', sales: { net: '180.00', count: 1 }, cash: { inHand: '180.00', over: false }, target: { achievement: '18.0' },
    });
    expect(team?.rows[0]?.since).toBeInstanceOf(Date);
    expect(team?.rows[1]).toMatchObject({ status: 'NOT_IN', since: null, sales: { net: '0.00', count: 0 }, cash: { inHand: '0.00' }, target: null });
    expect(team?.counts).toEqual({ WORKING: 1, ON_BREAK: 0, AWAITING: 0, DONE: 0, NOT_IN: 1 });
  });

  it('RPT-014: money owed — the total, what is overdue and how late, the stores most overdue, the blocked, and this month\'s collections', async () => {
    const ctx = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx, { creditLimit: '100000.00' });
    await recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 2 }] }); // 180.00, due at the week's close
    await adjustBalance(ctx, store.id, { amount: '300.00', reason: 'Opening balance', dueOn: addDays(today, -45) });
    // Oldest first (CRD-003): the payment goes to the overdue balance.
    await recordPayment(seller.ctx, { storeId: store.id, ...(await paid(seller.ctx, '100.00')) });

    const { owed } = await getDashboard(ctx);
    expect(owed).toMatchObject({
      aged: { NOT_DUE: '180.00', DAYS_31_60: '200.00', total: '380.00' }, overdue: '200.00', owing: 1, blocked: 1,
      mostOverdue: [{ store: { id: store.id }, seller: { id: seller.account.id }, overdue: '200.00', total: '380.00', worst: 'DAYS_31_60' }],
      collected: { cash: '100.00', bank: '0.00', total: '100.00', payments: 1 },
    });
  });

  it('RPT-015: stock alerts — batches flagged for expiry, items to reorder, and purchase orders due in, the late ones counted', async () => {
    const ctx = await admin();
    const soon = addDays(today, 60);
    await okraInWarehouse(ctx, { expiresOn: soon }); // 20 bags and 10 pouches, inside the 90-day warning
    const due = await anOrderInTransit(ctx, { expectedArrival: addDays(today, -3) });

    const { stock } = await getDashboard(ctx);
    expect(stock?.expiring).toMatchObject({ batches: 2, packs: 30 });
    expect(stock?.expiring?.soonest[0]).toMatchObject({ expiresOn: soon, daysLeft: 60, time: true });
    expect(stock?.incoming).toMatchObject({ orders: 1, late: 1, next: [{ poId: due.po.id, number: due.po.number, packs: 30, lines: 2 }] });
    expect(stock?.reorder?.items).toBe(stock?.reorder?.top.length);
  });

  it('ADR-0054: each block only for those allowed its figures — the warehouse sees stock; a sales manager all but reordering and targets; a seller nothing', async () => {
    const warehouse = await ctxFor(await anAccount('MANAGER'), { overrides: presetOverrides(PRESET_DEFAULTS.WAREHOUSE) });
    const w = await getDashboard(warehouse);
    expect(w).toMatchObject({ sales: null, team: null, owed: null });
    expect(w.stock).toMatchObject({ reorder: null, expiring: { batches: 0 }, incoming: { orders: 0 } });

    const sales = await ctxFor(await anAccount('MANAGER'), { overrides: presetOverrides(PRESET_DEFAULTS.SALES_MANAGER) });
    const s = await getDashboard(sales);
    expect(s.sales?.recent).toEqual([]);
    expect(s.team?.columns).toEqual({ status: true, sales: true, cash: true, target: false });
    expect(s.owed).not.toBeNull();
    expect(s.stock?.reorder).toBeNull();

    const seller = await aSeller();
    expect(await getDashboard(seller.ctx)).toMatchObject({ sales: null, team: null, owed: null, stock: null });
  });
});
