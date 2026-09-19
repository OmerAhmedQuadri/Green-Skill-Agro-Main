import {
  businessDate, daysBetween, DomainError, packsHeld, quantity, RATE_WINDOW_DAYS, rateFlag, timeFlag,
  type BatchId, type CountUnit, type RateFlag, type SkuId, type SkuUnits,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { sizeOf } from '../catalogue';
import { authorize, authorizeAny, type Ctx } from '../context';
import { audit, inTx } from '../platform';
import { getDb } from '../runtime';
import { readSettings } from '../system';

const { batches, skus, products, categories, productTypes, stockMovements, stockFlags } = schema;

type Named = { readonly nameEn: string; readonly nameAr: string };

export type ExpiryFlag = {
  readonly batchId: BatchId; readonly skuId: SkuId; readonly code: string; readonly product: Named; readonly category: Named;
  readonly lotNumber: string | null; readonly expiresOn: string; readonly daysLeft: number; readonly warningDays: number;
  readonly heldPacks: number; readonly countUnit: CountUnit;
  /** EXP-001 */ readonly time: boolean;
  /** EXP-002..005, 008 */ readonly rate: RateFlag;
  /** `inventory.manage_expiry`: put first in line for clearance (EXP-006). */ readonly prioritised: boolean; readonly note: string | null;
};

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * EXP-001..005, 008: every batch held that has an expiry date — batches of
 * a type with expiry disabled have none and never appear (CAT-016) — with its
 * time-based and rate-based flags. Derived when read, never stored stale.
 */
export async function listExpiryFlags(ctx: Ctx, filter: { onlyFlagged?: boolean | undefined } = {}): Promise<ExpiryFlag[]> {
  authorizeAny(ctx, ['inventory.view_all_stock', 'inventory.manage_expiry']);
  const flags = await computeExpiryFlags(ctx.now);
  return flags
    .filter((f) => !filter.onlyFlagged || f.time || f.rate.flagged || f.prioritised)
    .sort((a, b) => Number(b.prioritised) - Number(a.prioritised) || a.expiresOn.localeCompare(b.expiresOn));
}

/**
 * The flags without the permission check — for use cases that have already
 * authorised their caller, such as a seller's own vehicle stock (EXP-007).
 * `batchIds` narrows the batches considered.
 */
export async function computeExpiryFlags(now: Date, batchIds?: readonly string[]): Promise<ExpiryFlag[]> {
  if (batchIds?.length === 0) return [];
  const db = getDb();
  const settings = await readSettings(db);
  const today = businessDate(now);
  const held = sql<string>`coalesce(sum(${stockMovements.quantity}) filter (where ${stockMovements.accountKind} in ('WAREHOUSE', 'VEHICLE', 'DISPATCHED')), 0)`;
  const rows = await db.select({
    batch: batches, sku: skus, productEn: products.nameEn, productAr: products.nameAr, categoryEn: categories.nameEn, categoryAr: categories.nameAr,
    categoryDays: categories.expiryWarningDays, countUnit: productTypes.countUnit, held,
  }).from(batches)
    .innerJoin(skus, eq(skus.id, batches.skuId)).innerJoin(products, eq(products.id, skus.productId))
    .innerJoin(categories, eq(categories.id, products.categoryId)).innerJoin(productTypes, eq(productTypes.id, products.productTypeId))
    .innerJoin(stockMovements, eq(stockMovements.batchId, batches.id))
    .where(and(isNotNull(batches.expiresOn), batchIds ? inArray(batches.id, [...batchIds]) : undefined))
    .groupBy(batches.id, skus.id, products.id, categories.id, productTypes.id)
    .having(sql`${held} > 0`);
  if (rows.length === 0) return [];

  const heldIds = rows.map((r) => r.batch.id);
  const skuIds = [...new Set(rows.map((r) => r.sku.id))];
  const windowStart = new Date(now.getTime() - RATE_WINDOW_DAYS * DAY);
  const seasonEnd = new Date(now.getTime() - 365 * DAY);
  const seasonStart = new Date(seasonEnd.getTime() - RATE_WINDOW_DAYS * DAY);
  const sold = (from: Date, to: Date) => and(eq(stockMovements.accountKind, 'SOLD'), gte(stockMovements.occurredAt, from), lt(stockMovements.occurredAt, to));
  const [trailing, seasonal, firstSale, flags] = await Promise.all([
    db.select({ batchId: stockMovements.batchId, q: sql<string>`sum(${stockMovements.quantity})` }).from(stockMovements)
      .where(and(inArray(stockMovements.batchId, heldIds), sold(windowStart, now))).groupBy(stockMovements.batchId),
    // A batch did not exist a year ago; its SKU's sales in the same window stand in for it (ADR-0030).
    db.select({ skuId: batches.skuId, q: sql<string>`sum(${stockMovements.quantity})` }).from(stockMovements)
      .innerJoin(batches, eq(batches.id, stockMovements.batchId))
      .where(and(inArray(batches.skuId, skuIds), sold(seasonStart, seasonEnd))).groupBy(batches.skuId),
    db.select({ at: sql<Date | null>`min(${stockMovements.occurredAt})` }).from(stockMovements).where(eq(stockMovements.accountKind, 'SOLD')),
    db.select().from(stockFlags).where(inArray(stockFlags.batchId, heldIds)),
  ]);
  // EXP-008: seasonal figures mean something only after a full trading year.
  const firstSaleAt = firstSale[0]?.at ? new Date(firstSale[0].at) : null;
  const haveSeason = firstSaleAt !== null && firstSaleAt.getTime() <= seasonEnd.getTime();

  const out = rows.map((r) => {
    const size = sizeOf(r.sku);
    const units: SkuUnits = size.measure === 'WEIGHT' ? { measure: 'WEIGHT', packWeightG: size.packWeightG } : { measure: 'COUNT', packCount: size.packCount };
    const expiresOn = r.batch.expiresOn ?? today;
    const warningDays = r.categoryDays ?? settings['expiry.warning_days'];
    const flag = stockFlagFor(flags, r.batch.id);
    return {
      batchId: r.batch.id as BatchId, skuId: r.sku.id as SkuId, code: r.sku.code, lotNumber: r.batch.lotNumber, expiresOn,
      product: { nameEn: r.productEn, nameAr: r.productAr }, category: { nameEn: r.categoryEn, nameAr: r.categoryAr },
      daysLeft: daysBetween(today, expiresOn), warningDays, heldPacks: packsHeld(quantity(r.held), units), countUnit: r.countUnit,
      time: timeFlag(expiresOn, today, warningDays),
      rate: rateFlag({
        held: quantity(r.held), expiresOn, today,
        soldTrailing: quantity(trailing.find((t) => t.batchId === r.batch.id)?.q ?? '0'),
        soldSeasonal: haveSeason ? quantity(seasonal.find((s) => s.skuId === r.sku.id)?.q ?? '0') : null,
        daysHeld: daysBetween(iso(r.batch.firstReceivedAt), today), basis: settings['expiry.rate_basis'],
      }),
      prioritised: flag?.prioritised ?? false, note: flag?.note ?? null,
    };
  });
  return out;
}

const stockFlagFor = (flags: (typeof stockFlags.$inferSelect)[], batchId: string) => flags.find((f) => f.batchId === batchId);

/** Batches proposed first when stock is issued (EXP-006): flagged on time or rate, or prioritised by a manager. */
export async function flaggedBatchIds(ctx: Ctx): Promise<Set<string>> {
  return new Set((await listExpiryFlags(ctx, { onlyFlagged: true })).map((f) => f.batchId));
}

/** `inventory.manage_expiry`: put a batch first in line for clearance, or take it out, with a note. */
export async function setClearancePriority(ctx: Ctx, batchId: string, input: { prioritised: boolean; note?: string | null | undefined }): Promise<void> {
  authorize(ctx, 'inventory.manage_expiry');
  await inTx(ctx, async (tx) => {
    const [batch] = await tx.select({ id: batches.id }).from(batches).where(eq(batches.id, batchId));
    if (!batch) throw new DomainError('NOT_FOUND', { entity: 'batch', id: batchId });
    const note = input.note?.trim() || null;
    await tx.insert(stockFlags).values({ batchId, prioritised: input.prioritised, note, updatedAt: ctx.now, updatedBy: ctx.user.id })
      .onConflictDoUpdate({ target: stockFlags.batchId, set: { prioritised: input.prioritised, note, updatedAt: ctx.now, updatedBy: ctx.user.id } });
    await audit(tx, ctx, { action: 'inventory.clearance_priority_set', entityType: 'batch', entityId: batchId, after: { prioritised: input.prioritised, note } });
  });
}
