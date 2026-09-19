import {
  bilingualName, dec, DomainError, price, type CountUnit, type Money, type PackSize, type Packaging, type PriceListId, type SkuId,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { sizeOf } from '../catalogue';
import { authorize, type Ctx } from '../context';
import { audit, inTx, mapUniqueViolations, snapshot, type Executor } from '../platform';
import { getDb } from '../runtime';

const { priceLists, priceListItems, skus, products, varieties, productTypes } = schema;

export type PriceList = {
  readonly id: PriceListId; readonly nameEn: string; readonly nameAr: string; readonly isBase: boolean;
  readonly isActive: boolean; readonly version: number; readonly itemCount: number;
};

export type PriceListRow = {
  readonly skuId: SkuId; readonly code: string; readonly isActive: boolean;
  readonly productEn: string; readonly productAr: string; readonly varietyEn: string | null; readonly varietyAr: string | null;
  readonly size: PackSize; readonly packaging: Packaging; readonly countUnit: CountUnit;
  readonly price: Money | null;
};

const duplicateName = new DomainError('DUPLICATE_NAME', { field: 'nameEn' });

async function loadLists(db: Executor): Promise<PriceList[]> {
  const rows = await db.select({
    id: priceLists.id, nameEn: priceLists.nameEn, nameAr: priceLists.nameAr, isBase: priceLists.isBase,
    isActive: priceLists.isActive, version: priceLists.version,
    itemCount: sql<number>`(select count(*)::int from ${priceListItems} where ${priceListItems.priceListId} = ${priceLists.id})`,
  }).from(priceLists).orderBy(sql`${priceLists.isBase} desc`, asc(priceLists.nameEn));
  return rows.map((r) => ({ ...r, id: r.id as PriceListId }));
}

async function loadList(db: Executor, id: string): Promise<PriceList> {
  const found = (await loadLists(db)).find((l) => l.id === id);
  if (!found) throw new DomainError('NOT_FOUND', { entity: 'price_list', id });
  return found;
}

/** PRC-002/003: the base list first, then the additional lists. */
export async function listPriceLists(ctx: Ctx): Promise<PriceList[]> {
  authorize(ctx, 'pricing.manage_price_lists');
  return loadLists(getDb());
}

/** One row per SKU — priced or not — so a list can be filled in from one screen. */
export async function getPriceList(ctx: Ctx, id: string): Promise<{ list: PriceList; rows: PriceListRow[] }> {
  authorize(ctx, 'pricing.manage_price_lists');
  const db = ctx.tx ?? getDb(); // after a change, the request's transaction sees it
  const list = await loadList(db, id);
  const rows = await db.select({
    sku: skus, productEn: products.nameEn, productAr: products.nameAr, varietyEn: varieties.nameEn, varietyAr: varieties.nameAr,
    countUnit: productTypes.countUnit, price: priceListItems.price,
  })
    .from(skus)
    .innerJoin(products, eq(products.id, skus.productId))
    .innerJoin(productTypes, eq(productTypes.id, products.productTypeId))
    .leftJoin(varieties, eq(varieties.id, skus.varietyId))
    .leftJoin(priceListItems, and(eq(priceListItems.skuId, skus.id), eq(priceListItems.priceListId, id)))
    .orderBy(asc(skus.code));
  return {
    list,
    rows: rows.map((r) => ({
      skuId: r.sku.id as SkuId, code: r.sku.code, isActive: r.sku.isActive,
      productEn: r.productEn, productAr: r.productAr, varietyEn: r.varietyEn, varietyAr: r.varietyAr,
      size: sizeOf(r.sku), packaging: r.sku.packaging, countUnit: r.countUnit, price: (r.price ?? null) as Money | null,
    })),
  };
}

/** PRC-003: an additional list, e.g. for bulk buyers. Stores are assigned to it from M5. */
export async function createPriceList(ctx: Ctx, input: { nameEn: string; nameAr: string }): Promise<PriceList> {
  authorize(ctx, 'pricing.manage_price_lists');
  const name = bilingualName(input);
  return inTx(ctx, async (tx) => {
    const [row] = await mapUniqueViolations(tx.insert(priceLists).values({ ...name, createdBy: ctx.user.id, updatedBy: ctx.user.id })
      .returning({ id: priceLists.id }), { price_lists_name_en_unique: duplicateName });
    if (!row) throw new Error('price list insert returned nothing');
    await audit(tx, ctx, { action: 'pricing.price_list_created', entityType: 'price_list', entityId: row.id, after: name });
    return loadList(tx, row.id);
  });
}

/** The base list can be renamed but never retired: every store falls back to it (PRC-002). */
export async function updatePriceList(
  ctx: Ctx, id: string, input: { version: number; nameEn?: string | undefined; nameAr?: string | undefined; isActive?: boolean | undefined },
): Promise<PriceList> {
  authorize(ctx, 'pricing.manage_price_lists');
  return inTx(ctx, async (tx) => {
    const current = await loadList(tx, id);
    if (current.isBase && input.isActive === false) throw new DomainError('REFERENCE_INACTIVE', { entity: 'price_list', id, reason: 'BASE' });
    const next = {
      ...bilingualName({ nameEn: input.nameEn ?? current.nameEn, nameAr: input.nameAr ?? current.nameAr }),
      isActive: input.isActive ?? current.isActive,
    };
    const [row] = await mapUniqueViolations(tx.update(priceLists)
      .set({ ...next, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 })
      .where(and(eq(priceLists.id, id), eq(priceLists.version, input.version)))
      .returning({ id: priceLists.id }), { price_lists_name_en_unique: duplicateName });
    if (!row) throw new DomainError('VERSION_CONFLICT', { entity: 'price_list', id });
    await audit(tx, ctx, { action: 'pricing.price_list_updated', entityType: 'price_list', entityId: id, before: snapshot(current, next), after: next });
    return loadList(tx, id);
  });
}

/**
 * PRC-001: sets prices per SKU on one list; a null price removes the SKU from
 * the list. Sales copy the price they sold at, so changing it never rewrites history.
 */
export async function setPriceListItems(
  ctx: Ctx, id: string, items: readonly { skuId: string; price: string | null }[],
): Promise<{ list: PriceList; rows: PriceListRow[] }> {
  authorize(ctx, 'pricing.manage_price_lists');
  const cleaned = items.map((i) => ({ skuId: i.skuId, price: i.price === null ? null : price(i.price) }));
  await inTx(ctx, async (tx) => {
    const list = await loadList(tx, id);
    if (!list.isActive) throw new DomainError('REFERENCE_INACTIVE', { entity: 'price_list', id });
    const before = await tx.select({ skuId: priceListItems.skuId, price: priceListItems.price }).from(priceListItems).where(eq(priceListItems.priceListId, id));
    const changes: { skuId: string; before: string | null; after: string | null }[] = [];
    for (const item of cleaned) {
      const was = before.find((b) => b.skuId === item.skuId)?.price ?? null;
      if (item.price === null) {
        await tx.delete(priceListItems).where(and(eq(priceListItems.priceListId, id), eq(priceListItems.skuId, item.skuId)));
      } else {
        const [sku] = await tx.select({ id: skus.id }).from(skus).where(eq(skus.id, item.skuId));
        if (!sku) throw new DomainError('NOT_FOUND', { entity: 'sku', id: item.skuId });
        await tx.insert(priceListItems).values({ priceListId: id, skuId: item.skuId, price: item.price, updatedAt: ctx.now, updatedBy: ctx.user.id })
          .onConflictDoUpdate({ target: [priceListItems.priceListId, priceListItems.skuId], set: { price: item.price, updatedAt: ctx.now, updatedBy: ctx.user.id } });
      }
      const same = was !== null && item.price !== null ? dec(was).eq(dec(item.price)) : was === item.price;
      if (!same) changes.push({ skuId: item.skuId, before: was, after: item.price });
    }
    if (changes.length) await audit(tx, ctx, { action: 'pricing.prices_changed', entityType: 'price_list', entityId: id, after: { changes } });
  });
  return getPriceList(ctx, id);
}
