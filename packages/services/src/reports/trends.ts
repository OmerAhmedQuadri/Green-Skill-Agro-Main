import { movements, type Movement } from '@gsa/core';
import { schema } from '@gsa/db';
import { desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { getDb } from '../runtime';
import { daysBack } from './rollup';

const { salesDailyRollup, categories, products, skus, stores, users } = schema;

/** RPT-001: the dimensions a trend can be cut by. */
export const TREND_DIMENSIONS = ['PRODUCT', 'SKU', 'SELLER', 'STORE', 'CATEGORY'] as const;
export type TrendDimension = (typeof TREND_DIMENSIONS)[number];

export type TrendRow = {
  readonly key: string;
  readonly label: { readonly nameEn: string; readonly nameAr: string };
  readonly movements: readonly Movement[];
};

export type Trends = {
  readonly dimension: TrendDimension;
  readonly compare: 'PREVIOUS' | 'YEAR_AGO';
  readonly months: readonly string[];
  readonly rows: readonly TrendRow[];
  /** RPT-011: under a year of history, this is a guide rather than a projection. */
  readonly guide: boolean;
};

const month = sql<string>`to_char(${salesDailyRollup.day}, 'YYYY-MM')`;

/** Packs and revenue, net of what came back (RET-009). */
const netPacks = sql<string>`sum(${salesDailyRollup.packs} - ${salesDailyRollup.returnedPacks})::text`;
const netRevenue = sql<string>`sum(${salesDailyRollup.revenue} - ${salesDailyRollup.returnedValue})::text`;

type Cut = { key: SQL<string>; nameEn: SQL<string>; nameAr: SQL<string> };

/**
 * RPT-001, RPT-002 (ADR-0043): month-on-month and year-on-year movement, cut by
 * product, SKU, seller, store or category. Reads the nightly rollup — a trend
 * that is a day old is a trend; a stock figure that is a day old is a mistake,
 * and comes from the ledger instead (DATA-MODEL §6).
 */
export async function salesTrends(
  ctx: Ctx,
  input: { dimension?: TrendDimension | undefined; compare?: 'PREVIOUS' | 'YEAR_AGO' | undefined; months?: number | undefined } = {},
): Promise<Trends> {
  authorize(ctx, 'reports.view_trends');
  const db = ctx.tx ?? getDb();
  const dimension = input.dimension ?? 'PRODUCT';
  const compare = input.compare ?? 'PREVIOUS';
  // Year-on-year needs the same months a year earlier to compare against.
  const span = (input.months ?? 12) + (compare === 'YEAR_AGO' ? 12 : 1);
  const from = daysBack(new Date(ctx.now).toISOString().slice(0, 10), span * 31);

  const cut = cutFor(dimension);
  const rows = await db.select({
    key: cut.key, nameEn: cut.nameEn, nameAr: cut.nameAr,
    period: month, packs: netPacks, revenue: netRevenue,
  }).from(salesDailyRollup)
    .innerJoin(skus, eq(skus.id, salesDailyRollup.skuId))
    .innerJoin(products, eq(products.id, skus.productId))
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .innerJoin(users, eq(users.id, salesDailyRollup.sellerId))
    .innerJoin(stores, eq(stores.id, salesDailyRollup.storeId))
    .where(gte(salesDailyRollup.day, from))
    .groupBy(cut.key, cut.nameEn, cut.nameAr, month)
    .orderBy(desc(month));

  const byKey = new Map<string, { label: { nameEn: string; nameAr: string }; points: { period: string; packs: number; revenue: string }[] }>();
  for (const row of rows) {
    const key = String(row.key);
    const entry = byKey.get(key) ?? { label: { nameEn: row.nameEn ?? '', nameAr: row.nameAr ?? '' }, points: [] };
    entry.points.push({ period: row.period, packs: Number(row.packs), revenue: row.revenue });
    byKey.set(key, entry);
  }

  const months = [...new Set(rows.map((r) => r.period))].sort().slice(-(input.months ?? 12));
  const earliest = [...new Set(rows.map((r) => r.period))].sort()[0] ?? null;
  return {
    dimension, compare, months,
    rows: [...byKey].map(([key, entry]) => ({
      key, label: entry.label,
      movements: movements(entry.points.sort((a, b) => a.period.localeCompare(b.period)), compare)
        .filter((m) => months.includes(m.period)),
    })).sort((a, b) => a.label.nameEn.localeCompare(b.label.nameEn)),
    // RPT-011: a year of trading is what year-on-year needs to mean anything.
    guide: earliest === null || monthsBetween(earliest, months[months.length - 1] ?? earliest) < 12,
  };
}

function cutFor(dimension: TrendDimension): Cut {
  switch (dimension) {
    // I18N-003: names are data, shown in the reader's language. A code or a person's
    // name has one form, so both columns carry it.
    case 'SKU': return { key: sql<string>`${skus.id}`, nameEn: sql<string>`${skus.code}`, nameAr: sql<string>`${skus.code}` };
    case 'SELLER': return { key: sql<string>`${users.id}`, nameEn: sql<string>`${users.name}`, nameAr: sql<string>`${users.name}` };
    case 'STORE': return { key: sql<string>`${stores.id}`, nameEn: sql<string>`${stores.name}`, nameAr: sql<string>`${stores.name}` };
    case 'CATEGORY': return { key: sql<string>`${categories.id}`, nameEn: sql<string>`${categories.nameEn}`, nameAr: sql<string>`${categories.nameAr}` };
    case 'PRODUCT': return { key: sql<string>`${products.id}`, nameEn: sql<string>`${products.nameEn}`, nameAr: sql<string>`${products.nameAr}` };
  }
}

const monthsBetween = (from: string, to: string): number =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5)) - Number(from.slice(5)));

/** Whether there is a year of trading behind the figures (RPT-011). */
export async function hasSeasonOfHistory(ctx: Ctx): Promise<boolean> {
  const db = ctx.tx ?? getDb();
  const [row] = await db.select({ earliest: sql<string | null>`min(${salesDailyRollup.day})::text` }).from(salesDailyRollup);
  if (!row?.earliest) return false;
  return Date.parse(row.earliest) <= ctx.now.getTime() - 365 * 86_400_000;
}
