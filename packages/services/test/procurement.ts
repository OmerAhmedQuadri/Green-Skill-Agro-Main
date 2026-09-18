import type { PoAction } from '@gsa/core';
import type { Ctx } from '../src/context';
import { createSku, type ProductDetail } from '../src/catalogue';
import { createPurchaseOrder, transitionPurchaseOrder, type PoDetail } from '../src/procurement';
import { anOkra } from './catalogue';

/** Okra / Parbhani Kranti in a 5 kg bag and a 1 kg pouch — two SKUs of one variety. */
export async function okraSkus(ctx: Ctx) {
  const base = await anOkra(ctx);
  await createSku(ctx, base.product.id, { varietyId: base.variety.id, size: { measure: 'WEIGHT', value: '5', unit: 'KG' }, packaging: 'BAG' });
  const product: ProductDetail = await createSku(ctx, base.product.id, { varietyId: base.variety.id, size: { measure: 'WEIGHT', value: '1', unit: 'KG' }, packaging: 'POUCH' });
  // By pack, not code: a second Okra in one test gets suffixed codes (CAT-008).
  const bag = product.skus.find((s) => s.packaging === 'BAG');
  const pouch = product.skus.find((s) => s.packaging === 'POUCH');
  if (!bag || !pouch) throw new Error('okra SKUs missing');
  return { ...base, product, bag, pouch };
}

/** Moves an order along the given actions, as the given user. */
export async function advance(ctx: Ctx, po: PoDetail, actions: readonly PoAction[]): Promise<PoDetail> {
  let current = po;
  for (const action of actions) current = await transitionPurchaseOrder(ctx, current.id, action, { version: current.version, reason: action === 'cancel' || action === 'close_short' || action === 'reject' ? 'test reason' : null });
  return current;
}

/** An order for 20 bags and 10 pouches, taken to IN_TRANSIT by an Admin. */
export async function anOrderInTransit(ctx: Ctx, opts: { expectedArrival?: string } = {}) {
  const okra = await okraSkus(ctx);
  const draft = await createPurchaseOrder(ctx, {
    vendorId: okra.vendor.id, expectedArrival: opts.expectedArrival ?? '2026-10-20', lines: [
      { skuId: okra.bag.id, orderedPacks: 20, expectedUnitCost: '70.00' },
      { skuId: okra.pouch.id, orderedPacks: 10, expectedUnitCost: '16.50' },
    ],
  });
  const po = await advance(ctx, draft, ['submit', 'approve', 'place', 'despatch']);
  const bagLine = po.lines.find((l) => l.skuId === okra.bag.id);
  const pouchLine = po.lines.find((l) => l.skuId === okra.pouch.id);
  if (!bagLine || !pouchLine) throw new Error('order lines missing');
  return { ...okra, po, bagLine, pouchLine };
}
