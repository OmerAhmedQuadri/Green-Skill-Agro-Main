import { businessDate } from '@gsa/core';
import type { Ctx } from '../src/context';
import { createPurchaseOrder, receiveGoods } from '../src/procurement';
import { advance, anOrderInTransit } from './procurement';

/**
 * When okra from `okraInWarehouse` expires: two years after the run, so clear of
 * the 90-day expiry warning whenever the suite runs — a fixed date (2027-12-31)
 * would have entered it on 2027-10-02. Fixed once per run, so a test can compare.
 */
export const OKRA_EXPIRES_ON = businessDate(new Date(Date.now() + 730 * 86_400_000));

/** 20 bags and 10 pouches of Okra received into the warehouse, LOT W1, expiring two years after the run. */
export async function okraInWarehouse(ctx: Ctx, opts: { receivedAt?: Date; expiresOn?: string } = {}) {
  const order = await anOrderInTransit(ctx);
  const lines = [order.bagLine, order.pouchLine].map((l, i) => ({
    purchaseOrderLineId: l.id, packs: i === 0 ? 20 : 10, lotNumber: 'W1', manufacturedOn: '2026-01-10', expiresOn: opts.expiresOn ?? OKRA_EXPIRES_ON,
  }));
  const po = await receiveGoods(ctx, order.po.id, { version: order.po.version, lines, receivedAt: opts.receivedAt });
  return { ...order, po };
}

/** A second consignment of the same Okra bags, as its own batch. */
export async function moreBags(ctx: Ctx, okra: Awaited<ReturnType<typeof okraInWarehouse>>, opts: { packs: number; lotNumber: string; expiresOn: string }) {
  const draft = await createPurchaseOrder(ctx, { vendorId: okra.vendor.id, lines: [{ skuId: okra.bag.id, orderedPacks: opts.packs, expectedUnitCost: '70.00' }] });
  const po = await advance(ctx, draft, ['submit', 'approve', 'place', 'despatch']);
  const line = po.lines[0];
  if (!line) throw new Error('order line missing');
  return receiveGoods(ctx, po.id, { version: po.version, lines: [{ purchaseOrderLineId: line.id, packs: opts.packs, lotNumber: opts.lotNumber, manufacturedOn: '2026-01-10', expiresOn: opts.expiresOn }] });
}
