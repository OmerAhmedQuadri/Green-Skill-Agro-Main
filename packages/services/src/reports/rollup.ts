import { businessDate, type UserId } from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { inTx, type Executor } from '../platform';
import { defaultBranchId, getDb } from '../runtime';

const { salesDailyRollup, returns, returnLines, sales, saleLines } = schema;

/** The Riyadh business day of a timestamp, as the database sees it. */
const dayOf = (column: unknown) => sql`(${column} at time zone 'Asia/Riyadh')::date`;

/**
 * RPT-001, RPT-002 (ADR-0043): rebuild the sales rollup for a span of days.
 *
 * Derived data, so a rebuild replaces rather than accumulates: the day is
 * deleted and written again from the sales themselves. That makes the job safe
 * to run twice, and safe to run over an old day after a correction — which is
 * the whole reason not to keep a running total instead.
 */
export async function rebuildRollup(ctx: Ctx, from: string, to: string): Promise<{ days: number; rows: number }> {
  const db = ctx.tx ?? getDb();
  const branchId = ctx.branchId;

  const sold = await db.select({
    day: sql<string>`${dayOf(sales.completedAt)}`,
    skuId: saleLines.skuId,
    sellerId: sales.sellerId,
    storeId: sales.storeId,
    packs: sql<string>`sum(${saleLines.packs})::text`,
    revenue: sql<string>`sum(${saleLines.total})::text`,
  }).from(saleLines).innerJoin(sales, eq(sales.id, saleLines.saleId))
    .where(and(
      eq(sales.status, 'COMPLETED'),
      gte(dayOf(sales.completedAt), from),
      lt(dayOf(sales.completedAt), to),
    ))
    .groupBy(sql`1`, saleLines.skuId, sales.sellerId, sales.storeId);

  // RET-009: what came back, on the day the credit note was raised — never by
  // reaching into the month of the original sale.
  // A return line points at the sale line it came back from, which is where the SKU lives.
  const returned = await db.select({
    day: sql<string>`${dayOf(returns.occurredAt)}`,
    skuId: saleLines.skuId,
    sellerId: returns.sellerId,
    storeId: returns.storeId,
    packs: sql<string>`sum(${returnLines.packs})::text`,
    value: sql<string>`sum(${returnLines.amount})::text`,
  }).from(returnLines)
    .innerJoin(returns, eq(returns.id, returnLines.returnId))
    .innerJoin(saleLines, eq(saleLines.id, returnLines.saleLineId))
    .where(and(
      eq(returns.kind, 'CREDIT_NOTE'),
      gte(dayOf(returns.occurredAt), from),
      lt(dayOf(returns.occurredAt), to),
    ))
    .groupBy(sql`1`, saleLines.skuId, returns.sellerId, returns.storeId);

  type Row = { day: string; skuId: string; sellerId: string; storeId: string; packs: number; revenue: string; returnedPacks: number; returnedValue: string };
  const rows = new Map<string, Row>();
  const keyOf = (r: { day: string; skuId: string; sellerId: string; storeId: string }) => `${r.day}|${r.skuId}|${r.sellerId}|${r.storeId}`;
  for (const r of sold) {
    rows.set(keyOf(r), {
      day: r.day, skuId: r.skuId, sellerId: r.sellerId, storeId: r.storeId,
      packs: Number(r.packs), revenue: r.revenue, returnedPacks: 0, returnedValue: '0.00',
    });
  }
  for (const r of returned) {
    const key = keyOf(r);
    const existing = rows.get(key);
    if (existing) {
      rows.set(key, { ...existing, returnedPacks: Number(r.packs), returnedValue: r.value });
    } else {
      // Goods back on a day the store bought nothing: still a real movement.
      rows.set(key, {
        day: r.day, skuId: r.skuId, sellerId: r.sellerId, storeId: r.storeId,
        packs: 0, revenue: '0.00', returnedPacks: Number(r.packs), returnedValue: r.value,
      });
    }
  }

  await inTx(ctx, async (tx) => {
    await tx.delete(salesDailyRollup).where(and(gte(salesDailyRollup.day, from), lt(salesDailyRollup.day, to)));
    if (rows.size > 0) {
      await tx.insert(salesDailyRollup).values([...rows.values()].map((r) => ({
        id: newId(), day: r.day, skuId: r.skuId, sellerId: r.sellerId, storeId: r.storeId,
        packs: r.packs, revenue: r.revenue, returnedPacks: r.returnedPacks, returnedValue: r.returnedValue,
        branchId, builtAt: ctx.now,
      })));
    }
  });

  return { days: daysBetween(from, to), rows: rows.size };
}

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string): number =>
  Math.max(Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS), 0);

/** The day after a `YYYY-MM-DD`. */
export const dayAfter = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** `count` days back from and including `day`. */
export const daysBack = (day: string, count: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) - count * DAY_MS).toISOString().slice(0, 10);

/**
 * RPT-001: rebuild on demand. A manager who has just corrected something should
 * not have to wait an hour to see the trend catch up, and the rebuild replaces
 * the days it covers, so asking for it twice costs nothing.
 */
export async function rebuildNow(ctx: Ctx, days = 2): Promise<{ days: number; rows: number }> {
  authorize(ctx, 'reports.view_trends');
  return rebuildRecentDays(ctx, days);
}

/**
 * The nightly pass. Rebuilds yesterday and today — today because sales are
 * still landing, yesterday because a late one may have arrived after the
 * previous run.
 */
export async function rebuildRecentDays(ctx: Ctx, days = 2): Promise<{ days: number; rows: number }> {
  const today = businessDate(ctx.now);
  return rebuildRollup(ctx, daysBack(today, days - 1), dayAfter(today));
}

export const workerCtx = async (now: Date): Promise<Ctx> => ({
  user: { id: '00000000-0000-4000-8000-000000000000' as UserId, role: 'ADMIN' },
  permissions: new Set(), now, requestId: 'worker', locale: 'en', branchId: await defaultBranchId(), ip: null,
});

export const sweepRollup = async (now: Date) => rebuildRecentDays(await workerCtx(now));

/** Everything the rollup knows about one SKU over a span, for the demand rate. */
export async function packsSold(db: Executor, skuIds: readonly string[], from: string, to: string): Promise<Map<string, number>> {
  if (skuIds.length === 0) return new Map();
  const rows = await db.select({
    skuId: salesDailyRollup.skuId,
    packs: sql<string>`sum(${salesDailyRollup.packs} - ${salesDailyRollup.returnedPacks})::text`,
  }).from(salesDailyRollup)
    .where(and(
      inArray(salesDailyRollup.skuId, [...skuIds]),
      gte(salesDailyRollup.day, from),
      lt(salesDailyRollup.day, to),
    ))
    .groupBy(salesDailyRollup.skuId);
  return new Map(rows.map((r) => [r.skuId, Math.max(Number(r.packs), 0)]));
}
