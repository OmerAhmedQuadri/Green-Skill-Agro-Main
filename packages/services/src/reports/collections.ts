import { ageDebts, analyticsRange, businessDate, Dec, dec, toMoney, type Ageing, type AnalyticsRange, type Money } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { getDb } from '../runtime';
import { openDebits } from '../stores';

const { payments, stores, storeAssignments, users } = schema;

/** RPT-008: money collected from stores in a period — the seller and store filters of a sales view, nothing else. */
export type CollectionsFilter = {
  readonly from: string; readonly to: string;
  readonly sellerId?: string | undefined; readonly storeId?: string | undefined;
};

export type CollectedRow = {
  readonly seller: { readonly id: string; readonly name: string };
  readonly cash: Money; readonly bank: Money; readonly total: Money; readonly payments: number;
};

export type OwedRow = {
  readonly store: { readonly id: string; readonly name: string };
  /** Who manages the store now; null for a store nobody has. */ readonly seller: { readonly id: string; readonly name: string } | null;
  readonly aged: Ageing;
};

export type Collections = {
  readonly range: Pick<AnalyticsRange, 'from' | 'to' | 'days'>;
  readonly collected: { readonly cash: Money; readonly bank: Money; readonly total: Money; readonly payments: number; readonly bySeller: readonly CollectedRow[] };
  /** As of now, whatever the period: what each store owes, by how late it is. */
  readonly owed: { readonly aged: Ageing; readonly byStore: readonly OwedRow[] };
};

const ZERO = toMoney(new Dec(0));

/**
 * RPT-008 (ADR-0048): what each seller collected in the period, by method, and
 * what each store owes now, aged by days past due. Money is collected from a
 * store — not for a product, nor on a vehicle — so only the seller and store
 * filters apply. Store balances are store data, so this needs
 * `stores.view_all` as well as the reports permission.
 */
export async function collectionsView(ctx: Ctx, filter: CollectionsFilter): Promise<Collections> {
  authorize(ctx, 'reports.view_trends');
  authorize(ctx, 'stores.view_all');
  const range = analyticsRange(filter.from, filter.to);
  const db = ctx.tx ?? getDb();

  const rows = await db.select({
    sellerId: payments.receivedBy, sellerName: users.name, method: payments.method,
    amount: sql<string>`coalesce(sum(${payments.amount}), 0)::numeric(14,2)::text`, count: sql<number>`count(*)::int`,
  }).from(payments)
    .innerJoin(users, eq(users.id, payments.receivedBy))
    .where(and(
      gte(payments.receivedAt, range.start), lt(payments.receivedAt, range.end),
      filter.sellerId ? eq(payments.receivedBy, filter.sellerId) : undefined, filter.storeId ? eq(payments.storeId, filter.storeId) : undefined,
    ))
    .groupBy(payments.receivedBy, users.name, payments.method);
  const bySeller = new Map<string, { name: string; cash: Dec; bank: Dec; payments: number }>();
  for (const r of rows) {
    const e = bySeller.get(r.sellerId) ?? { name: r.sellerName, cash: new Dec(0), bank: new Dec(0), payments: 0 };
    bySeller.set(r.sellerId, {
      ...e, payments: e.payments + Number(r.count),
      cash: r.method === 'CASH' ? e.cash.plus(dec(r.amount)) : e.cash, bank: r.method === 'BANK_TRANSFER' ? e.bank.plus(dec(r.amount)) : e.bank,
    });
  }
  const collected = [...bySeller].map(([id, e]) => ({
    seller: { id, name: e.name }, cash: toMoney(e.cash), bank: toMoney(e.bank), total: toMoney(e.cash.plus(e.bank)), payments: e.payments,
  })).sort((a, b) => dec(b.total).comparedTo(dec(a.total)) || a.seller.name.localeCompare(b.seller.name));
  const add = (pick: (r: CollectedRow) => Money) => toMoney(collected.reduce((t, r) => t.plus(dec(pick(r))), new Dec(0)));

  // What stores owe now: every store that trades, with who manages it today.
  const manager = sql`(select ${storeAssignments.sellerId} from ${storeAssignments} where ${storeAssignments.storeId} = ${stores.id} and ${storeAssignments.endedAt} is null)`;
  const candidates = await db.select({ id: stores.id, name: stores.name, sellerId: storeAssignments.sellerId, sellerName: users.name }).from(stores)
    .leftJoin(storeAssignments, and(eq(storeAssignments.storeId, stores.id), isNull(storeAssignments.endedAt)))
    .leftJoin(users, eq(users.id, storeAssignments.sellerId))
    .where(and(
      ne(stores.status, 'REJECTED'),
      filter.storeId ? eq(stores.id, filter.storeId) : undefined,
      filter.sellerId ? sql`${manager} = ${filter.sellerId}` : undefined,
    ))
    .orderBy(asc(stores.name));
  const debits = candidates.length ? await openDebits(db, candidates.map((c) => c.id)) : [];
  const today = businessDate(ctx.now);
  const owing = candidates.map((c) => ({
    store: { id: c.id, name: c.name },
    seller: c.sellerId && c.sellerName ? { id: c.sellerId, name: c.sellerName } : null,
    aged: ageDebts(debits.filter((d) => d.storeId === c.id), today),
  })).filter((r) => dec(r.aged.total).gt(0))
    .sort((a, b) => dec(b.aged.total).comparedTo(dec(a.aged.total)) || a.store.name.localeCompare(b.store.name));

  return {
    range: { from: range.from, to: range.to, days: range.days },
    collected: {
      cash: collected.length ? add((r) => r.cash) : ZERO, bank: collected.length ? add((r) => r.bank) : ZERO,
      total: collected.length ? add((r) => r.total) : ZERO, payments: collected.reduce((n, r) => n + r.payments, 0), bySeller: collected,
    },
    owed: { aged: ageDebts(debits, today), byStore: owing },
  };
}
