import { assertWithinMaximum, dec, DomainError, percent, type Percent, type SkuId } from '@gsa/core';
import { schema } from '@gsa/db';
import { asc, eq } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { audit, inTx } from '../platform';
import { getDb } from '../runtime';
import { readSettings, updateSettings } from '../system';

const { skuDiscountCeilings, skus } = schema;

export type DiscountCeilings = {
  /** PRC-004 */ readonly orderCeiling: Percent;
  /** PRC-005: applies to every SKU without its own ceiling. */ readonly itemCeiling: Percent;
  /** PRC-016 */ readonly absoluteMaximum: Percent;
  /** PRC-015 */ readonly approvalExpiryMinutes: number;
  readonly skuCeilings: readonly { readonly skuId: SkuId; readonly code: string; readonly ceiling: Percent }[];
};

/** PRC-004..007: the overall ceiling, the item ceilings, and the limits on approval. */
export async function getDiscountCeilings(ctx: Ctx): Promise<DiscountCeilings> {
  authorize(ctx, 'pricing.set_discount_ceilings');
  const db = getDb();
  const [settings, items] = await Promise.all([
    readSettings(db),
    db.select({ skuId: skuDiscountCeilings.skuId, code: skus.code, ceiling: skuDiscountCeilings.ceiling })
      .from(skuDiscountCeilings).innerJoin(skus, eq(skus.id, skuDiscountCeilings.skuId)).orderBy(asc(skus.code)),
  ]);
  return {
    orderCeiling: percent(settings['discount.order_ceiling']),
    itemCeiling: percent(settings['discount.item_ceiling']),
    absoluteMaximum: percent(settings['discount.absolute_maximum']),
    approvalExpiryMinutes: settings['discount.approval_expiry_minutes'],
    skuCeilings: items.map((i) => ({ skuId: i.skuId as SkuId, code: i.code, ceiling: percent(dec(i.ceiling).toString()) })),
  };
}

export async function setDiscountCeilings(
  ctx: Ctx,
  input: { orderCeiling?: string | undefined; itemCeiling?: string | undefined; absoluteMaximum?: string | undefined; approvalExpiryMinutes?: number | undefined },
): Promise<DiscountCeilings> {
  authorize(ctx, 'pricing.set_discount_ceilings');
  const changes = [
    ['discount.order_ceiling', input.orderCeiling],
    ['discount.item_ceiling', input.itemCeiling],
    ['discount.absolute_maximum', input.absoluteMaximum],
    ['discount.approval_expiry_minutes', input.approvalExpiryMinutes],
  ].filter(([, value]) => value !== undefined).map(([key, value]) => ({ key: key as string, value }));
  if (changes.length) await updateSettings(ctx, changes);
  return getDiscountCeilings(ctx);
}

/** PRC-005: one SKU's own ceiling; null returns it to the default item ceiling. */
export async function setSkuDiscountCeiling(ctx: Ctx, skuId: string, ceiling: string | null): Promise<DiscountCeilings> {
  authorize(ctx, 'pricing.set_discount_ceilings');
  const value = ceiling === null ? null : percent(ceiling);
  await inTx(ctx, async (tx) => {
    const [sku] = await tx.select({ id: skus.id }).from(skus).where(eq(skus.id, skuId));
    if (!sku) throw new DomainError('NOT_FOUND', { entity: 'sku', id: skuId });
    if (value !== null) assertWithinMaximum(value, percent((await readSettings(tx))['discount.absolute_maximum']), 'ceiling');
    const [current] = await tx.select({ ceiling: skuDiscountCeilings.ceiling }).from(skuDiscountCeilings).where(eq(skuDiscountCeilings.skuId, skuId));
    if (value === null) await tx.delete(skuDiscountCeilings).where(eq(skuDiscountCeilings.skuId, skuId));
    else {
      await tx.insert(skuDiscountCeilings).values({ skuId, ceiling: value, updatedAt: ctx.now, updatedBy: ctx.user.id })
        .onConflictDoUpdate({ target: skuDiscountCeilings.skuId, set: { ceiling: value, updatedAt: ctx.now, updatedBy: ctx.user.id } });
    }
    await audit(tx, ctx, {
      action: 'pricing.sku_ceiling_changed', entityType: 'sku', entityId: skuId,
      before: { ceiling: current?.ceiling ?? null }, after: { ceiling: value },
    });
  });
  return getDiscountCeilings(ctx);
}
