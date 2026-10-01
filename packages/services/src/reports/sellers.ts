import { analyticsRange, Dec, dec, toMoney, wholeMonthOf, type AnalyticsRange, type Money } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { listAttendance } from '../attendance';
import { authorize, type Ctx } from '../context';
import { getDb } from '../runtime';
import { standingsFor } from '../targets';
import { salesBySeller } from './analytics';
import { collectedBySeller } from './performance';

const { stores, users } = schema;

export type SellerRow = {
  readonly seller: { readonly id: string; readonly name: string };
  readonly net: Money; readonly sales: number;
  /** Collected from stores in the range, cash and transfer (RPT-008). */ readonly collected: Money;
  /** Stores they onboarded that became customers (TGT-003's sense). */ readonly newStores: number;
  /** With `attendance.view` only — null otherwise, or with no odometer readings. */ readonly distanceKm: number | null;
  /** With `attendance.view` only. */ readonly activeMs: number | null;
  /** One whole calendar month, with `targets.view_commission` only. */
  readonly month: {
    readonly hasTarget: boolean; readonly met: boolean;
    /** The figure furthest from its goal — the one that decides "met" (OQ-023). */ readonly lowestAchievement: string | null;
    readonly rate: string | null; readonly commission: Money | null; readonly final: boolean;
  } | null;
};

export type SellerPerformance = {
  readonly range: Pick<AnalyticsRange, 'from' | 'to' | 'days'>;
  /** The month targets and commission are shown for, when the range is exactly one. */ readonly month: string | null;
  /** Which parts the reader may see, so the screen leaves out — rather than empties — the rest. */
  readonly shows: { readonly attendance: boolean; readonly commission: boolean };
  readonly sellers: readonly SellerRow[];
};

/**
 * RPT-010 (ADR-0048): each seller over a range — net sales, collections, new
 * stores, distance and active hours; target achievement and commission when
 * the range is one whole month, since both are monthly. Distance and hours need
 * `attendance.view`, commission `targets.view_commission`; without them those
 * columns are simply not there.
 */
export async function sellerPerformance(ctx: Ctx, filter: { from: string; to: string; sellerId?: string | undefined }): Promise<SellerPerformance> {
  authorize(ctx, 'reports.view_trends');
  const range = analyticsRange(filter.from, filter.to);
  const db = ctx.tx ?? getDb();

  const sales = await salesBySeller(db, range, filter.sellerId);
  // Every active seller, and anyone since deactivated who still sold in the range.
  const sold = [...sales.keys()];
  const sellers = await db.select({ id: users.id, name: users.name }).from(users)
    .where(and(
      eq(users.role, 'SELLER'),
      sold.length ? or(eq(users.status, 'ACTIVE'), inArray(users.id, sold)) : eq(users.status, 'ACTIVE'),
      filter.sellerId ? eq(users.id, filter.sellerId) : undefined,
    ))
    .orderBy(asc(users.name));
  const ids = sellers.map((s) => s.id);

  const collected = await collectedBySeller(db, ids, range.start, range.end);
  const onboarded = ids.length ? await db.select({ sellerId: stores.createdBy, count: sql<number>`count(*)::int` }).from(stores)
    .where(and(
      inArray(stores.createdBy, ids), inArray(stores.status, ['ACTIVE', 'INACTIVE']),
      gte(stores.createdAt, range.start), lt(stores.createdAt, range.end),
    ))
    .groupBy(stores.createdBy) : [];
  const newStores = new Map(onboarded.flatMap((r) => (r.sellerId ? [[r.sellerId, Number(r.count)] as const] : [])));

  const seesAttendance = ctx.permissions.has('attendance.view') || ctx.permissions.has('attendance.manage');
  const worked = new Map<string, { activeMs: number; distanceKm: number | null }>();
  if (seesAttendance) {
    // One seller at a time: a year of one seller's days fits the attendance list's page; everyone's would not.
    for (const id of ids) {
      const days = await listAttendance(ctx, { from: range.from, to: range.to, sellerId: id });
      const distances = days.map((d) => d.totals.distanceKm).filter((km): km is number => km !== null);
      worked.set(id, { activeMs: days.reduce((ms, d) => ms + d.totals.activeMs, 0), distanceKm: distances.length ? distances.reduce((a, b) => a + b, 0) : null });
    }
  }

  const month = wholeMonthOf(range);
  const seesCommission = ctx.permissions.has('targets.view_commission');
  const standings = month && seesCommission ? new Map((await standingsFor(db, sellers, month, ctx.now)).map((s) => [s.seller.id, s])) : null;

  const zero = toMoney(new Dec(0));
  return {
    range: { from: range.from, to: range.to, days: range.days },
    month: month && seesCommission ? month : null,
    shows: { attendance: seesAttendance, commission: Boolean(standings) },
    sellers: sellers.map((s) => {
      const standing = standings?.get(s.id);
      const achievements = standing?.progress.metrics.map((m) => dec(m.achievement)) ?? [];
      return {
        seller: s,
        net: sales.get(s.id)?.net ?? zero, sales: sales.get(s.id)?.sales ?? 0,
        collected: collected.get(s.id)?.total ?? zero,
        newStores: newStores.get(s.id) ?? 0,
        distanceKm: worked.get(s.id)?.distanceKm ?? null, activeMs: seesAttendance ? (worked.get(s.id)?.activeMs ?? 0) : null,
        month: standing ? {
          hasTarget: standing.goals !== null, met: standing.progress.met,
          lowestAchievement: achievements.length ? Dec.min(...achievements).toFixed(1) : null,
          rate: standing.rate, commission: standing.commission, final: standing.final,
        } : null,
      };
    }).sort((a, b) => dec(b.net).comparedTo(dec(a.net)) || a.seller.name.localeCompare(b.seller.name)),
  };
}
