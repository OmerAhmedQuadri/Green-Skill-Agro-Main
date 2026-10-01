import { businessDate, type DomainError } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { anAccount, ctxFor } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { aSellingSeller } from '../../test/sales';
import { basePriceListId } from '../../test/stores';
import { confirmReceipt, raiseDispatchOrder, releaseOrder } from '../dispatch';
import { setPriceListItems } from '../pricing';
import { getReturnable, recordReturn } from '../returns';
import { listSales, recordSale } from '../sales';
import { analyticsOptions, salesAnalytics } from './analytics';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const today = businessDate(new Date());

/**
 * One seller's day: two vehicle sales of Okra bags at 90.00 (3 and 2), one bag
 * of the first brought back on a credit note; and a warehouse dispatch of two
 * bags and two pouches at 20.00 to the same store, one pouch of it brought back
 * too — so each channel has a return of its own for a filter to tell apart.
 */
async function aDayOfSales() {
  const admin = await ctxFor(await anAccount('ADMIN'));
  const setup = await aSellingSeller(admin, { packs: 6, creditMode: 'WEEKLY', creditLimit: '100000.00' });
  await setPriceListItems(admin, await basePriceListId(), [{ skuId: setup.pouch.id, price: '20.00' }]);
  const first = await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 3 }] }); // 270.00
  await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 2 }] }); // 180.00
  const line = first.lines[0];
  if (!line) throw new Error('the sale has no lines');
  await recordReturn(setup.seller.ctx, {
    saleId: first.id, kind: 'CREDIT_NOTE', condition: 'DEFECTIVE',
    lines: [{ saleLineId: line.id, batchId: setup.bagBatch.batchId, packs: 1, saleable: false }],
  }); // −90.00
  const { orderId } = await raiseDispatchOrder(setup.seller.ctx, {
    storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 2 }, { skuId: setup.pouch.id, packs: 2 }],
  }); // 220.00
  const order = await releaseOrder(admin, orderId ?? '', { version: 1, transportSlipPhotoId: await aPhoto(admin, 'TRANSPORT_SLIP') });
  const delivered = await confirmReceipt(setup.seller.ctx, order.id, {
    version: order.version, mode: 'IN_PERSON', lines: order.lines.map((l) => ({ lineId: l.id, received: l.packs, short: 0, damaged: 0 })),
  });
  const pouches = (await getReturnable(setup.seller.ctx, delivered.sale.id)).lines.find((l) => l.skuId === setup.pouch.id);
  const pouchBatch = pouches?.batches[0]?.batchId;
  if (!pouches || !pouchBatch) throw new Error('the dispatch has no pouches');
  await recordReturn(setup.seller.ctx, {
    saleId: delivered.sale.id, kind: 'CREDIT_NOTE', condition: 'DEFECTIVE',
    lines: [{ saleLineId: pouches.saleLineId, batchId: pouchBatch, packs: 1, saleable: false }],
  }); // −20.00
  return { ...setup, admin, firstSaleId: first.id };
}

describe('sales analytics (ADR-0048)', () => {
  it('ADR-0048, RET-009: the day\'s sales net of the credit note — totals, channels and the run', async () => {
    const day = await aDayOfSales();
    const view = await salesAnalytics(day.admin, { from: today, to: today, sellerId: day.seller.account.id });
    // 270 + 180 by vehicle, 220 dispatched; a bag (90) and a pouch (20) back.
    expect(view.totals).toMatchObject({ sold: '670.00', returned: '110.00', net: '560.00', sales: 3, packs: 7 });
    expect(view.totals.average).toBe('223.33');
    expect(view.channels).toEqual({ VEHICLE: '360.00', DISPATCH: '200.00' });
    expect(view.range).toMatchObject({ from: today, to: today, days: 1, bucket: 'DAY' });
    expect(view.series).toEqual([{ period: today, sold: '670.00', returned: '110.00', net: '560.00', sales: 3, packs: 7 }]);
  });

  it('ADR-0048: who, where and what — by seller, store, product and category, biggest first', async () => {
    const day = await aDayOfSales();
    const view = await salesAnalytics(day.admin, { from: today, to: today, sellerId: day.seller.account.id });
    expect(view.bySeller.map((r) => [r.id, r.net, r.sales])).toEqual([[day.seller.account.id, '560.00', 3]]);
    expect(view.bySeller[0]?.label.nameEn).toMatch(/^SELLER /);
    expect(view.byStore.map((r) => [r.id, r.net])).toEqual([[day.store.id, '560.00']]);
    // Bags and pouches are both Okra: nine packs sold, two back.
    expect(view.byProduct.map((r) => [r.id, r.net, r.packs])).toEqual([[day.product.id, '560.00', 7]]);
    expect(view.byProduct[0]?.label.nameEn).toBe(day.product.nameEn);
    expect(view.byCategory.map((r) => r.net)).toEqual(['560.00']);
  });

  it('ADR-0048: each filter cuts the sales and what came back from them alike', async () => {
    const day = await aDayOfSales();
    const view = (more: Partial<Parameters<typeof salesAnalytics>[1]>) =>
      salesAnalytics(day.admin, { from: today, to: today, sellerId: day.seller.account.id, ...more });
    // Each credit note follows the sale it came back from: the pouch to the warehouse, the bag to the vehicle.
    expect((await view({ channel: 'DISPATCH' })).totals).toMatchObject({ sold: '220.00', returned: '20.00', net: '200.00', sales: 1 });
    expect((await view({ channel: 'VEHICLE' })).totals).toMatchObject({ sold: '450.00', returned: '90.00', net: '360.00', sales: 2 });
    expect((await view({ vehicleId: day.vehicle.id })).totals).toMatchObject({ sold: '450.00', returned: '90.00', net: '360.00', sales: 2 });
    expect((await view({ productId: day.product.id })).totals).toMatchObject({ sold: '670.00', returned: '110.00', net: '560.00', sales: 3 });
    expect((await view({ productId: crypto.randomUUID() })).totals).toMatchObject({ sold: '0.00', returned: '0.00', sales: 0 });
    expect((await view({ categoryId: day.product.category.id })).totals.net).toBe('560.00');
    expect((await view({ categoryId: crypto.randomUUID() })).totals.net).toBe('0.00');
    const elsewhere = await aSellingSeller(day.admin);
    expect((await view({ storeId: elsewhere.store.id })).totals).toMatchObject({ sold: '0.00', returned: '0.00', sales: 0 });
  });

  it('ADR-0048: the list of sales takes the same cuts, and shows the vehicle', async () => {
    const day = await aDayOfSales();
    const list = (more: Partial<Parameters<typeof listSales>[1]>) => listSales(day.admin, { from: today, to: today, sellerId: day.seller.account.id, ...more });
    expect((await list({})).items).toHaveLength(3);
    const dispatched = (await list({ channel: 'DISPATCH' })).items;
    expect(dispatched.map((s) => [s.channel, s.total, s.vehicle])).toEqual([['DISPATCH', '220.00', null]]);
    const byVehicle = (await list({ vehicleId: day.vehicle.id })).items;
    expect(byVehicle.map((s) => s.vehicle?.registration)).toEqual([day.vehicle.registration, day.vehicle.registration]);
    expect((await list({ productId: day.product.id })).items).toHaveLength(3);
    expect((await list({ productId: crypto.randomUUID() })).items).toHaveLength(0);
    expect(await code(listSales(day.admin, { from: today }))).toBe('INVALID_DATE');
  });

  it('ADR-0048: a long range runs month by month; a range is a year at most; the view is the reports permission\'s', async () => {
    const day = await aDayOfSales();
    const view = await salesAnalytics(day.admin, { from: '2026-01-01', to: '2026-12-31', sellerId: day.seller.account.id });
    expect(view.range.bucket).toBe('MONTH');
    expect(view.series.map((p) => p.period)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']);
    expect(view.series.find((p) => p.period === today.slice(0, 7))?.net).toBe('560.00');
    expect(await code(salesAnalytics(day.admin, { from: '2025-01-01', to: '2026-12-31' }))).toBe('RANGE_TOO_LONG');
    expect(await code(salesAnalytics(day.seller.ctx, { from: today, to: today }))).toBe('FORBIDDEN');
    expect(await code(analyticsOptions(day.seller.ctx))).toBe('FORBIDDEN');
    const options = await analyticsOptions(day.admin);
    expect(options.sellers.map((s) => s.id)).toContain(day.seller.account.id);
    expect(options.vehicles.map((v) => v.id)).toContain(day.vehicle.id);
  });
});
