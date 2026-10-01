import { businessDate, type PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { anAccount, ctxFor } from '../../test/factories';
import { aSellingSeller, paid } from '../../test/sales';
import { recordSale } from '../sales';
import { recordPayment } from '../stores';
import { setCommissionRate } from '../system';
import { setTarget } from '../targets';
import { sellerPerformance } from './sellers';

const today = businessDate(new Date());
const month = today.slice(0, 7);
const lastDay = (m: string) => {
  const [y, mm] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
};
const manager = async (grants: PermissionCode[]) => ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });

/** A seller who onboarded a store today, sold it 450.00 on account and collected 150.00 of it. */
async function aWorkingSeller() {
  const admin = await ctxFor(await anAccount('ADMIN'));
  const setup = await aSellingSeller(admin, { creditMode: 'WEEKLY', creditLimit: '100000.00' });
  await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 5 }] });
  await recordPayment(setup.seller.ctx, { storeId: setup.store.id, ...(await paid(setup.seller.ctx, '150.00')) });
  return { ...setup, admin };
}

describe('seller performance (RPT-010, ADR-0048)', () => {
  it('RPT-010: net sales, collections and new stores for each seller in the range', async () => {
    const s = await aWorkingSeller();
    const view = await sellerPerformance(s.admin, { from: today, to: today, sellerId: s.seller.account.id });
    expect(view.sellers.map((r) => [r.seller.id, r.net, r.sales, r.collected, r.newStores]))
      .toEqual([[s.seller.account.id, '450.00', 1, '150.00', 1]]);
    // The seller checked in today: hours are counting; no check-out yet, so no distance.
    expect(view.shows.attendance).toBe(true);
    expect(view.sellers[0]?.activeMs).toBeGreaterThanOrEqual(0);
    expect(view.sellers[0]?.distanceKm).toBeNull();
    // A single day is not a month: no targets or commission.
    expect(view.month).toBeNull();
    expect(view.sellers[0]?.month).toBeNull();
  });

  it('RPT-010: for one whole month, target achievement and commission as the targets screen has them', async () => {
    const s = await aWorkingSeller();
    await setCommissionRate(s.admin, s.seller.account.id, { onTarget: '5', belowTarget: '2' });
    await setTarget(s.admin, { sellerId: s.seller.account.id, period: month, goals: { REVENUE: '900.00' } });
    const view = await sellerPerformance(s.admin, { from: `${month}-01`, to: lastDay(month), sellerId: s.seller.account.id });
    expect(view.month).toBe(month);
    // 450 of a 900 goal: half way, so the lower rate — on cash that reached the business, none yet.
    expect(view.sellers[0]?.month).toMatchObject({ hasTarget: true, met: false, lowestAchievement: '50.0', rate: '2.000', commission: '0.00', final: false });
  });

  it('ADR-0048: distance, hours and commission are there only for whoever may see them', async () => {
    const s = await aWorkingSeller();
    const reader = await manager(['reports.view_trends']);
    const view = await sellerPerformance(reader, { from: `${month}-01`, to: lastDay(month), sellerId: s.seller.account.id });
    expect(view.shows).toEqual({ attendance: false, commission: false });
    expect(view.month).toBeNull();
    expect(view.sellers[0]).toMatchObject({ net: '450.00', activeMs: null, distanceKm: null, month: null });
    const allowed = await manager(['reports.view_trends', 'attendance.view', 'targets.view_commission']);
    expect((await sellerPerformance(allowed, { from: `${month}-01`, to: lastDay(month), sellerId: s.seller.account.id })).shows)
      .toEqual({ attendance: true, commission: true });
  });
});
