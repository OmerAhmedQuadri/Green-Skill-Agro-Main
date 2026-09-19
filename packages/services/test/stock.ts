import type { Ctx } from '../src/context';
import { receiveGoods } from '../src/procurement';
import { anOrderInTransit } from './procurement';

/** 20 bags and 10 pouches of Okra received into the warehouse, LOT W1. */
export async function okraInWarehouse(ctx: Ctx, opts: { receivedAt?: Date; expiresOn?: string } = {}) {
  const order = await anOrderInTransit(ctx);
  const lines = [order.bagLine, order.pouchLine].map((l, i) => ({
    purchaseOrderLineId: l.id, packs: i === 0 ? 20 : 10, lotNumber: 'W1', manufacturedOn: '2026-01-10', expiresOn: opts.expiresOn ?? '2027-12-31',
  }));
  const po = await receiveGoods(ctx, order.po.id, { version: order.po.version, lines, receivedAt: opts.receivedAt });
  return { ...order, po };
}
