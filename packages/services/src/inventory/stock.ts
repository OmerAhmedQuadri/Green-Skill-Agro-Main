import {
  DomainError, packsHeld, quantity, type BatchId, type CountUnit, type PackSize, type Packaging, type SkuId, type SkuUnits,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, gt, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { sizeOf } from '../catalogue';
import { authorize, type Ctx } from '../context';
import { decodeCursor, encodeCursor, likePattern, pageLimit } from '../platform';
import { getDb } from '../runtime';

const { stockMovements, batches, skus, products, varieties, productTypes, purchaseOrders, purchaseOrderLines, goodsReceiptLines } = schema;

type Named = { readonly nameEn: string; readonly nameAr: string };

/** Whole packs in each place stock can be (DATA-MODEL §1.2). */
export type Positions = {
  /** STK-005: unissued stock available for dispatch. */ readonly warehouse: number;
  readonly vehicles: number;
  /** Released on a dispatch order, not yet confirmed — never vehicle stock (DSP-008). */ readonly dispatched: number;
  /** STK-004: every unit the business holds, wherever it sits. */ readonly total: number;
};

/** STK-007: ordered stock not yet here, kept apart from stock held. */
export type Incoming = { /** PLACED or CONFIRMED */ readonly onOrder: number; /** IN_TRANSIT, or the balance of a part receipt */ readonly inTransit: number };

export type SkuStock = {
  readonly skuId: SkuId; readonly code: string; readonly product: Named; readonly variety: Named | null;
  readonly size: PackSize; readonly packaging: Packaging; readonly countUnit: CountUnit; readonly isActive: boolean;
  readonly positions: Positions; readonly incoming: Incoming;
};

const unitsOf = (s: PackSize): SkuUnits => (s.measure === 'WEIGHT' ? { measure: 'WEIGHT', packWeightG: s.packWeightG } : { measure: 'COUNT', packCount: s.packCount });

function positions(units: SkuUnits, raw: { warehouse: string; vehicles: string; dispatched: string }): Positions {
  const warehouse = packsHeld(quantity(raw.warehouse), units);
  const vehicles = packsHeld(quantity(raw.vehicles), units);
  const dispatched = packsHeld(quantity(raw.dispatched), units);
  return { warehouse, vehicles, dispatched, total: warehouse + vehicles + dispatched };
}

const sumFor = (kind: 'WAREHOUSE' | 'VEHICLE' | 'DISPATCHED') =>
  sql<string>`coalesce(sum(${stockMovements.quantity}) filter (where ${stockMovements.accountKind} = ${kind}), 0)`;

/** Outstanding packs per SKU on live orders, split by how far along the order is. */
async function incomingBySku(skuIds: readonly string[]): Promise<Map<string, Incoming>> {
  if (skuIds.length === 0) return new Map();
  const received = sql<number>`coalesce((select sum(${goodsReceiptLines.packs}) from ${goodsReceiptLines} where ${goodsReceiptLines.purchaseOrderLineId} = ${purchaseOrderLines.id}), 0)::int`;
  const rows = await getDb()
    .select({ skuId: purchaseOrderLines.skuId, status: purchaseOrders.status, ordered: purchaseOrderLines.orderedPacks, received })
    .from(purchaseOrderLines).innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .where(and(inArray(purchaseOrderLines.skuId, [...skuIds]), inArray(purchaseOrders.status, ['PLACED', 'CONFIRMED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'])));
  const out = new Map<string, { onOrder: number; inTransit: number }>();
  for (const r of rows) {
    const e = out.get(r.skuId) ?? { onOrder: 0, inTransit: 0 };
    const outstanding = Math.max(r.ordered - r.received, 0);
    if (r.status === 'PLACED' || r.status === 'CONFIRMED') e.onOrder += outstanding; else e.inTransit += outstanding;
    out.set(r.skuId, e);
  }
  return out;
}

/** STK-004..007: stock by SKU — warehouse, vehicles, dispatched, total — with incoming shown apart. */
export async function listStock(
  ctx: Ctx,
  filter: { search?: string | undefined; productId?: string | undefined; skuId?: string | undefined; onlyHeld?: boolean | undefined; cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: SkuStock[]; nextCursor: string | null }> {
  authorize(ctx, 'inventory.view_all_stock');
  const limit = pageLimit(filter.limit, 100);
  const where: SQL[] = [];
  if (filter.productId) where.push(eq(skus.productId, filter.productId));
  if (filter.skuId) where.push(eq(skus.id, filter.skuId));
  if (filter.search) {
    const q = likePattern(filter.search);
    where.push(or(ilike(skus.code, q), ilike(products.nameEn, q), ilike(products.nameAr, q), ilike(varieties.nameEn, q), ilike(varieties.nameAr, q)) as SQL);
  }
  if (filter.cursor) where.push(gt(skus.code, decodeCursor(filter.cursor, 1)[0] ?? ''));
  const rows = await getDb()
    .select({
      sku: skus, productEn: products.nameEn, productAr: products.nameAr, varietyEn: varieties.nameEn, varietyAr: varieties.nameAr,
      countUnit: productTypes.countUnit, warehouse: sumFor('WAREHOUSE'), vehicles: sumFor('VEHICLE'), dispatched: sumFor('DISPATCHED'),
    })
    .from(skus)
    .innerJoin(products, eq(products.id, skus.productId))
    .innerJoin(productTypes, eq(productTypes.id, products.productTypeId))
    .leftJoin(varieties, eq(varieties.id, skus.varietyId))
    .leftJoin(batches, eq(batches.skuId, skus.id))
    .leftJoin(stockMovements, eq(stockMovements.batchId, batches.id))
    .where(and(...where))
    .groupBy(skus.id, products.id, productTypes.id, varieties.id)
    .orderBy(asc(skus.code))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const incoming = await incomingBySku(page.map((r) => r.sku.id));
  const items = page.map((r) => {
    const size = sizeOf(r.sku);
    return {
      skuId: r.sku.id as SkuId, code: r.sku.code, isActive: r.sku.isActive, size, packaging: r.sku.packaging, countUnit: r.countUnit,
      product: { nameEn: r.productEn, nameAr: r.productAr },
      variety: r.varietyEn !== null && r.varietyAr !== null ? { nameEn: r.varietyEn, nameAr: r.varietyAr } : null,
      positions: positions(unitsOf(size), r), incoming: incoming.get(r.sku.id) ?? { onOrder: 0, inTransit: 0 },
    };
  });
  const last = page.at(-1);
  return {
    items: filter.onlyHeld ? items.filter((i) => i.positions.total > 0 || i.incoming.onOrder + i.incoming.inTransit > 0) : items,
    nextCursor: rows.length > limit && last ? encodeCursor([last.sku.code]) : null,
  };
}

export type BatchStock = {
  readonly batchId: BatchId; readonly lotNumber: string | null; readonly manufacturedOn: string | null; readonly expiresOn: string | null;
  readonly firstReceivedAt: Date; readonly positions: Positions;
};

async function batchesFor(where: SQL) {
  return getDb()
    .select({
      batch: batches, sku: skus, productEn: products.nameEn, productAr: products.nameAr, varietyEn: varieties.nameEn, varietyAr: varieties.nameAr,
      countUnit: productTypes.countUnit, warehouse: sumFor('WAREHOUSE'), vehicles: sumFor('VEHICLE'), dispatched: sumFor('DISPATCHED'),
    })
    .from(batches)
    .innerJoin(skus, eq(skus.id, batches.skuId))
    .innerJoin(products, eq(products.id, skus.productId))
    .innerJoin(productTypes, eq(productTypes.id, products.productTypeId))
    .leftJoin(varieties, eq(varieties.id, skus.varietyId))
    .leftJoin(stockMovements, eq(stockMovements.batchId, batches.id))
    .where(where)
    .groupBy(batches.id, skus.id, products.id, productTypes.id, varieties.id)
    // FEFO order: earliest expiry first, no expiry last, then oldest receipt (DATA-MODEL §5.4).
    .orderBy(sql`${batches.expiresOn} asc nulls last`, asc(batches.firstReceivedAt));
}

const toBatchStock = (r: Awaited<ReturnType<typeof batchesFor>>[number]): BatchStock => ({
  batchId: r.batch.id as BatchId, lotNumber: r.batch.lotNumber, manufacturedOn: r.batch.manufacturedOn, expiresOn: r.batch.expiresOn,
  firstReceivedAt: r.batch.firstReceivedAt, positions: positions(unitsOf(sizeOf(r.sku)), r),
});

/** STK-001: one SKU's stock, batch by batch, in FEFO order. */
export async function getSkuStock(ctx: Ctx, skuId: string): Promise<{ sku: SkuStock; batches: BatchStock[] }> {
  const [sku] = (await listStock(ctx, { skuId })).items;
  if (!sku) throw new DomainError('NOT_FOUND', { entity: 'sku', id: skuId });
  const rows = await batchesFor(eq(batches.skuId, skuId));
  return { sku, batches: rows.map(toBatchStock) };
}

export type LotMatch = BatchStock & { readonly skuId: SkuId; readonly code: string; readonly product: Named; readonly variety: Named | null };

/** STK-003: LOT numbers stay searchable — and may match batches of different products (STK-002). */
export async function searchLots(ctx: Ctx, lot: string): Promise<LotMatch[]> {
  authorize(ctx, 'inventory.view_all_stock');
  if (!lot.trim()) return [];
  const rows = await batchesFor(ilike(batches.lotNumber, likePattern(lot.trim())));
  return rows.slice(0, 100).map((r) => ({
    ...toBatchStock(r), skuId: r.sku.id as SkuId, code: r.sku.code,
    product: { nameEn: r.productEn, nameAr: r.productAr },
    variety: r.varietyEn !== null && r.varietyAr !== null ? { nameEn: r.varietyEn, nameAr: r.varietyAr } : null,
  }));
}
