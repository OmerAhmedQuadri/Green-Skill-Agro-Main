import { dec, packCount, toBaseUnits, toPacks, quantity, type PackSize, type SaleBatch, type SkuUnits } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { sizeOf } from '../catalogue';
import { computeExpiryFlags, heldQuantity, warehouseAccount } from '../inventory';
import type { Executor } from '../platform';
import { unitsOf } from '../vehicles';

const { stockMovements, batches, skus } = schema;

/** Pack sizes by SKU, for turning packs into base units (ADR-0015). */
export async function skuUnits(db: Executor, skuIds: readonly string[]): Promise<Map<string, SkuUnits>> {
  if (skuIds.length === 0) return new Map();
  const rows = await db.select().from(skus).where(inArray(skus.id, [...skuIds]));
  return new Map(rows.map((r) => [r.id, unitsOf(sizeOf(r))]));
}

/**
 * DSP-007, OQ-019: the warehouse's batches of these SKUs with what can be
 * taken from each now — position less what write-offs and vehicle loads hold
 * — flagged batches first (EXP-006). Nothing is held for a dispatch request.
 */
export async function warehouseBatches(db: Executor, skuIds: readonly string[], now: Date): Promise<(SaleBatch & { packs: number; size: PackSize })[]> {
  if (skuIds.length === 0) return [];
  const account = await warehouseAccount(db);
  const held = sql<string>`sum(${stockMovements.quantity})`;
  const rows = await db.select({ batch: batches, sku: skus, held }).from(stockMovements)
    .innerJoin(batches, eq(batches.id, stockMovements.batchId)).innerJoin(skus, eq(skus.id, batches.skuId))
    .where(and(eq(stockMovements.accountKind, 'WAREHOUSE'), eq(stockMovements.warehouseId, account.warehouseId), inArray(batches.skuId, [...skuIds])))
    .groupBy(batches.id, skus.id).having(sql`${held} > 0`);
  const flags = await computeExpiryFlags(now, rows.map((r) => r.batch.id));
  const out: (SaleBatch & { packs: number; size: PackSize })[] = [];
  // One after the other: `db` may be a transaction — a single connection.
  for (const r of rows) {
    const size = sizeOf(r.sku);
    const free = dec(r.held).minus(dec(await heldQuantity(db, r.batch.id, account)));
    const packs = free.gt(0) ? toPacks(quantity(free.toFixed(3)), unitsOf(size)).floor().toNumber() : 0;
    const f = flags.find((x) => x.batchId === r.batch.id);
    out.push({
      batchId: r.batch.id, skuId: r.sku.id, expiresOn: r.batch.expiresOn, receivedAt: r.batch.firstReceivedAt,
      available: toBaseUnits(packCount(packs), unitsOf(size)), flagged: f ? f.time || f.rate.flagged || f.prioritised : false, packs, size,
    });
  }
  return out;
}

/** Whole packs of each SKU the warehouse could release now — shown, not reserved (OQ-019). */
export async function warehousePacks(db: Executor, skuIds: readonly string[], now: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>(skuIds.map((id) => [id, 0]));
  for (const b of await warehouseBatches(db, skuIds, now)) out.set(b.skuId, (out.get(b.skuId) ?? 0) + b.packs);
  return out;
}
