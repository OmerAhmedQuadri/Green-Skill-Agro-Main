import { analyticsRange, Dec, dec, OPEN_SALES_KEY, rangePeriods, toMoney, type AnalyticsRange, type Money } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, gte, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import type { Executor } from '../platform';
import { getDb } from '../runtime';

const { sales, saleLines, returns, returnLines, skus, products, categories, stores, users, vehicles } = schema;

/** ADR-0048: what a view of sales is cut by. Every field but the range is optional. */
export type AnalyticsFilter = {
  readonly from: string; readonly to: string;
  readonly sellerId?: string | undefined; readonly storeId?: string | undefined; readonly vehicleId?: string | undefined;
  readonly productId?: string | undefined; readonly categoryId?: string | undefined;
  readonly channel?: 'VEHICLE' | 'DISPATCH' | undefined;
};

type Named = { readonly nameEn: string; readonly nameAr: string };

/** Sold, what came back (RET-009), and what that leaves; how many sales, and the packs left with the stores. */
export type Figures = { readonly sold: Money; readonly returned: Money; readonly net: Money; readonly sales: number; readonly packs: number };
export type BreakdownRow = Figures & { readonly id: string; readonly label: Named };

export type SalesAnalytics = {
  readonly range: Pick<AnalyticsRange, 'from' | 'to' | 'days' | 'bucket'>;
  readonly totals: Figures & { /** Sold per sale, before returns; null with no sales. */ readonly average: Money | null };
  readonly channels: { readonly VEHICLE: Money; readonly DISPATCH: Money };
  /** Every day or month of the range, at nothing where nothing sold. */
  readonly series: readonly (Figures & { readonly period: string })[];
  readonly bySeller: readonly BreakdownRow[]; readonly byStore: readonly BreakdownRow[];
  readonly byProduct: readonly BreakdownRow[]; readonly byCategory: readonly BreakdownRow[];
};

const ZERO = toMoney(new Dec(0));
const riyadh = (column: unknown) => sql`(${column} at time zone 'Asia/Riyadh')`;

/** Completed sales in the range, cut by the filters — line by line, so product and category cut too. */
function soldWhere(range: AnalyticsRange, f: AnalyticsFilter): SQL | undefined {
  return and(
    eq(sales.status, 'COMPLETED'), gte(sales.completedAt, range.start), lt(sales.completedAt, range.end),
    f.sellerId ? eq(sales.sellerId, f.sellerId) : undefined, f.storeId ? eq(sales.storeId, f.storeId) : undefined,
    f.vehicleId ? eq(sales.vehicleId, f.vehicleId) : undefined, f.channel ? eq(sales.channel, f.channel) : undefined,
    f.productId ? eq(skus.productId, f.productId) : undefined, f.categoryId ? eq(products.categoryId, f.categoryId) : undefined,
  );
}

/**
 * RET-009: credit notes raised in the range, cut by the same filters. Seller
 * and store are the credit note's own; vehicle, channel, product and category
 * are reached through the sale line each line came back from.
 */
function returnedWhere(range: AnalyticsRange, f: AnalyticsFilter): SQL | undefined {
  return and(
    eq(returns.kind, 'CREDIT_NOTE'), gte(returns.occurredAt, range.start), lt(returns.occurredAt, range.end),
    f.sellerId ? eq(returns.sellerId, f.sellerId) : undefined, f.storeId ? eq(returns.storeId, f.storeId) : undefined,
    f.vehicleId ? eq(sales.vehicleId, f.vehicleId) : undefined, f.channel ? eq(sales.channel, f.channel) : undefined,
    f.productId ? eq(skus.productId, f.productId) : undefined, f.categoryId ? eq(products.categoryId, f.categoryId) : undefined,
  );
}

/** A way to cut the figures: the column on each side — what was sold, and what came back. */
type Cut = { readonly sold: SQL; readonly returned: SQL };

const CUTS = {
  seller: { sold: sql`${sales.sellerId}`, returned: sql`${returns.sellerId}` },
  // SAL-019 (ADR-0052): open sales have no store, and one line of their own. They are never returned.
  // A literal, not a parameter: selected and grouped by, it must be the same expression twice over.
  store: { sold: sql`coalesce(${sales.storeId}::text, ${sql.raw(`'${OPEN_SALES_KEY}'`)})`, returned: sql`${returns.storeId}` },
  product: { sold: sql`${skus.productId}`, returned: sql`${skus.productId}` },
  category: { sold: sql`${products.categoryId}`, returned: sql`${products.categoryId}` },
  channel: { sold: sql`${sales.channel}`, returned: sql`${sales.channel}` },
} satisfies Record<string, Cut>;

function periodCut(bucket: AnalyticsRange['bucket']): Cut {
  // A literal, not a parameter: Postgres matches the grouped expression to the selected one by its text.
  const format = sql.raw(bucket === 'DAY' ? `'YYYY-MM-DD'` : `'YYYY-MM'`);
  return { sold: sql`to_char(${riyadh(sales.completedAt)}, ${format})`, returned: sql`to_char(${riyadh(returns.occurredAt)}, ${format})` };
}

/** The figures by one cut: two grouped queries, sold and returned, merged by key. */
async function figuresBy(db: Executor, range: AnalyticsRange, f: AnalyticsFilter, cut: Cut): Promise<Map<string, Figures>> {
  const sold = await db.select({
    key: sql<string>`${cut.sold}::text`,
    amount: sql<string>`coalesce(sum(${saleLines.total}), 0)::numeric(14,2)::text`,
    packs: sql<number>`coalesce(sum(${saleLines.packs}), 0)::int`,
    sales: sql<number>`count(distinct ${sales.id})::int`,
  }).from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .innerJoin(skus, eq(skus.id, saleLines.skuId))
    .innerJoin(products, eq(products.id, skus.productId))
    .where(soldWhere(range, f))
    .groupBy(cut.sold);
  const returned = await db.select({
    key: sql<string>`${cut.returned}::text`,
    amount: sql<string>`coalesce(sum(${returnLines.amount}), 0)::numeric(14,2)::text`,
    packs: sql<number>`coalesce(sum(${returnLines.packs}), 0)::int`,
  }).from(returnLines)
    .innerJoin(returns, eq(returns.id, returnLines.returnId))
    .innerJoin(saleLines, eq(saleLines.id, returnLines.saleLineId))
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .innerJoin(skus, eq(skus.id, saleLines.skuId))
    .innerJoin(products, eq(products.id, skus.productId))
    .where(returnedWhere(range, f))
    .groupBy(cut.returned);

  const out = new Map<string, { sold: Dec; returned: Dec; sales: number; packs: number }>();
  const entry = (key: string) => out.get(key) ?? { sold: new Dec(0), returned: new Dec(0), sales: 0, packs: 0 };
  for (const r of sold) {
    const e = entry(r.key);
    out.set(r.key, { ...e, sold: e.sold.plus(dec(r.amount)), sales: e.sales + Number(r.sales), packs: e.packs + Number(r.packs) });
  }
  for (const r of returned) {
    const e = entry(r.key);
    out.set(r.key, { ...e, returned: e.returned.plus(dec(r.amount)), packs: e.packs - Number(r.packs) });
  }
  return new Map([...out].map(([key, e]) => [key, {
    sold: toMoney(e.sold), returned: toMoney(e.returned), net: toMoney(e.sold.minus(e.returned)), sales: e.sales, packs: e.packs,
  }]));
}

const NOTHING: Figures = { sold: ZERO, returned: ZERO, net: ZERO, sales: 0, packs: 0 };

const rows = (figures: Map<string, Figures>, labels: Map<string, Named>): BreakdownRow[] =>
  [...figures].map(([id, f]) => ({ id, label: labels.get(id) ?? { nameEn: id, nameAr: id }, ...f }))
    .sort((a, b) => dec(b.net).comparedTo(dec(a.net)) || a.label.nameEn.localeCompare(b.label.nameEn));

/** A person's or a store's name has one form, so both languages carry it. */
const oneForm = (list: readonly { id: string; name: string }[]) => new Map(list.map((r) => [r.id, { nameEn: r.name, nameAr: r.name }]));

/**
 * ADR-0048: the sales of a range, cut by whatever the reader chose — totals,
 * the run day by day or month by month, and who, where and what — net of the
 * credit notes raised in it (RET-009). Read live: a manager looking at today
 * sees today.
 */
export async function salesAnalytics(ctx: Ctx, filter: AnalyticsFilter): Promise<SalesAnalytics> {
  authorize(ctx, 'reports.view_trends');
  const range = analyticsRange(filter.from, filter.to);
  const db = ctx.tx ?? getDb();

  // One after another: `db` may be a transaction, and one connection takes one query at a time.
  const byPeriod = await figuresBy(db, range, filter, periodCut(range.bucket));
  const byChannel = await figuresBy(db, range, filter, CUTS.channel);
  const bySeller = await figuresBy(db, range, filter, CUTS.seller);
  const byStore = await figuresBy(db, range, filter, CUTS.store);
  const byProduct = await figuresBy(db, range, filter, CUTS.product);
  const byCategory = await figuresBy(db, range, filter, CUTS.category);

  const ids = (m: Map<string, Figures>) => [...m.keys()];
  const sellerNames = bySeller.size ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids(bySeller))) : [];
  const storeIds = ids(byStore).filter((id) => id !== OPEN_SALES_KEY);
  const storeNames = storeIds.length ? await db.select({ id: stores.id, name: stores.name }).from(stores).where(inArray(stores.id, storeIds)) : [];
  const productNames = byProduct.size
    ? await db.select({ id: products.id, nameEn: products.nameEn, nameAr: products.nameAr }).from(products).where(inArray(products.id, ids(byProduct))) : [];
  const categoryNames = byCategory.size
    ? await db.select({ id: categories.id, nameEn: categories.nameEn, nameAr: categories.nameAr }).from(categories).where(inArray(categories.id, ids(byCategory))) : [];

  const series = rangePeriods(range).map((period) => ({ period, ...(byPeriod.get(period) ?? NOTHING) }));
  const sum = (pick: (f: Figures) => string) => toMoney(series.reduce((t, p) => t.plus(dec(pick(p))), new Dec(0)));
  const totals = {
    sold: sum((p) => p.sold), returned: sum((p) => p.returned), net: sum((p) => p.net),
    sales: series.reduce((n, p) => n + p.sales, 0), packs: series.reduce((n, p) => n + p.packs, 0),
  };
  return {
    range: { from: range.from, to: range.to, days: range.days, bucket: range.bucket },
    totals: { ...totals, average: totals.sales > 0 ? toMoney(dec(totals.sold).div(totals.sales)) : null },
    channels: { VEHICLE: byChannel.get('VEHICLE')?.net ?? ZERO, DISPATCH: byChannel.get('DISPATCH')?.net ?? ZERO },
    series,
    bySeller: rows(bySeller, oneForm(sellerNames)),
    byStore: rows(byStore, oneForm(storeNames)),
    byProduct: rows(byProduct, new Map(productNames.map((p) => [p.id, { nameEn: p.nameEn, nameAr: p.nameAr }]))),
    byCategory: rows(byCategory, new Map(categoryNames.map((c) => [c.id, { nameEn: c.nameEn, nameAr: c.nameAr }]))),
  };
}

/** RPT-010: each seller's figures for a range, net of returns — what the seller performance table reads. */
export async function salesBySeller(db: Executor, range: AnalyticsRange, sellerId?: string): Promise<Map<string, Figures>> {
  return figuresBy(db, range, { from: range.from, to: range.to, sellerId }, CUTS.seller);
}

export type AnalyticsOptions = {
  readonly sellers: readonly { readonly id: string; readonly name: string }[];
  readonly stores: readonly { readonly id: string; readonly name: string }[];
  readonly vehicles: readonly { readonly id: string; readonly registration: string }[];
  readonly products: readonly (Named & { readonly id: string; readonly categoryId: string })[];
  readonly categories: readonly (Named & { readonly id: string })[];
};

/** ADR-0048: what the filters offer — every seller, store and vehicle that could have sold, every product and category. */
export async function analyticsOptions(ctx: Ctx): Promise<AnalyticsOptions> {
  authorize(ctx, 'reports.view_trends');
  const db = ctx.tx ?? getDb();
  return {
    sellers: await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.role, 'SELLER')).orderBy(asc(users.name)),
    // A store turned down never traded; one paused still has sales to look back on.
    stores: await db.select({ id: stores.id, name: stores.name }).from(stores).where(ne(stores.status, 'REJECTED')).orderBy(asc(stores.name)),
    vehicles: await db.select({ id: vehicles.id, registration: vehicles.registration }).from(vehicles).orderBy(asc(vehicles.registration)),
    products: await db.select({ id: products.id, nameEn: products.nameEn, nameAr: products.nameAr, categoryId: products.categoryId })
      .from(products).orderBy(asc(products.nameEn)),
    categories: await db.select({ id: categories.id, nameEn: categories.nameEn, nameAr: categories.nameAr }).from(categories).orderBy(asc(categories.nameEn)),
  };
}
