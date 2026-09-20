import {
  assertGoals, businessMonth, commissionFor, DomainError, daysInPeriod, elapsedInPeriod, isBehindPace, isFrozen, targetProgress,
  type Money, type TargetGoals, type TargetProgress,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { audit, inTx, type Executor } from '../platform';
import { getDb } from '../runtime';
import { readSettings } from '../system';
import { actualsForMany } from './actuals';

const { commissionPeriods, commissionRates, sellerTargets, users } = schema;

export type SellerTarget = {
  readonly id: string;
  readonly seller: { readonly id: string; readonly name: string };
  readonly period: string;
  readonly goals: TargetGoals;
  readonly note: string | null;
  readonly version: number;
};

export type TargetStanding = {
  readonly seller: { readonly id: string; readonly name: string };
  readonly period: string;
  readonly goals: TargetGoals | null;
  readonly progress: TargetProgress;
  /** TGT-006: below the pace the month needs, while days remain. */ readonly behindPace: boolean;
  readonly base: Money;
  readonly rate: string | null;
  readonly commission: Money | null;
  /** COM-008: true once the month has frozen and these figures are the snapshot. */ readonly final: boolean;
};

const goalsOf = (row: typeof sellerTargets.$inferSelect): TargetGoals => ({
  ...(row.revenue === null ? {} : { REVENUE: row.revenue }),
  ...(row.packsSold === null ? {} : { PACKS_SOLD: String(row.packsSold) }),
  ...(row.newStores === null ? {} : { NEW_STORES: String(row.newStores) }),
  ...(row.collected === null ? {} : { COLLECTED: row.collected }),
});

const toDto = (row: typeof sellerTargets.$inferSelect, name: string): SellerTarget => ({
  id: row.id, seller: { id: row.sellerId, name }, period: row.period, goals: goalsOf(row), note: row.note, version: row.version,
});

/** TGT-001, SYS-008: an Admin or permitted Manager sets one seller's month. */
export async function setTarget(
  ctx: Ctx,
  input: { sellerId: string; period: string; goals: TargetGoals; note?: string | null | undefined },
): Promise<SellerTarget> {
  authorize(ctx, 'targets.manage');
  assertGoals(input.goals);
  const closeAfterDays = (await readSettings(ctx.tx ?? getDb()))['period.close_after_days'];
  // COM-008: a month that has frozen is history; its target cannot be moved to flatter a figure.
  if (isFrozen(input.period, closeAfterDays, ctx.now)) throw new DomainError('PERIOD_CLOSED', { period: input.period });

  return inTx(ctx, async (tx) => {
    const [seller] = await tx.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.id, input.sellerId));
    if (!seller || seller.role !== 'SELLER') throw new DomainError('NOT_FOUND', { sellerId: input.sellerId });
    const [existing] = await tx.select().from(sellerTargets)
      .where(and(eq(sellerTargets.sellerId, input.sellerId), eq(sellerTargets.period, input.period)));
    const values = {
      revenue: input.goals.REVENUE ?? null,
      packsSold: input.goals.PACKS_SOLD === undefined ? null : Number(input.goals.PACKS_SOLD),
      newStores: input.goals.NEW_STORES === undefined ? null : Number(input.goals.NEW_STORES),
      collected: input.goals.COLLECTED ?? null,
      note: input.note ?? null,
    };
    const [row] = existing
      ? await tx.update(sellerTargets)
        .set({ ...values, updatedAt: ctx.now, updatedBy: ctx.user.id, version: existing.version + 1 })
        .where(eq(sellerTargets.id, existing.id)).returning()
      : await tx.insert(sellerTargets)
        .values({ id: newId(), sellerId: input.sellerId, period: input.period, branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id, ...values })
        .returning();
    if (!row) throw new DomainError('NOT_FOUND', { sellerId: input.sellerId });
    await audit(tx, ctx, {
      action: existing ? 'targets.changed' : 'targets.set', entityType: 'seller_target', entityId: row.id,
      before: existing ? goalsOf(existing) : null, after: goalsOf(row),
    });
    return toDto(row, seller.name);
  });
}

/** TGT-001: the targets set for a month; this one unless another is asked for. */
export async function listTargets(ctx: Ctx, period?: string): Promise<SellerTarget[]> {
  authorize(ctx, 'targets.manage');
  const db = ctx.tx ?? getDb();
  const rows = await db.select({ t: sellerTargets, name: users.name }).from(sellerTargets)
    .innerJoin(users, eq(users.id, sellerTargets.sellerId))
    .where(eq(sellerTargets.period, period ?? businessMonth(ctx.now))).orderBy(asc(users.name));
  return rows.map((r) => toDto(r.t, r.name));
}

/**
 * TGT-004, COM-004: where each seller stands. Once a month has frozen this is
 * the snapshot, word for word — never a fresh calculation that might disagree
 * with what the seller was told they had earned (COM-008).
 *
 * Batched: the console shows every seller at once, so the figures behind them
 * are gathered in a handful of queries rather than a handful each.
 */
export async function standingsFor(
  db: Executor, sellers: readonly { id: string; name: string }[], period: string, now: Date,
): Promise<TargetStanding[]> {
  if (sellers.length === 0) return [];
  const ids = sellers.map((s) => s.id);
  const settings = await readSettings(db);
  const snapshots = await db.select().from(commissionPeriods)
    .where(and(inArray(commissionPeriods.sellerId, ids), eq(commissionPeriods.period, period)));
  const frozen = new Map(snapshots.map((row) => [row.sellerId, row]));

  const live = ids.filter((id) => !frozen.has(id));
  const [targets, rates, actuals] = await Promise.all([
    live.length === 0 ? Promise.resolve([]) : db.select().from(sellerTargets)
      .where(and(inArray(sellerTargets.sellerId, live), eq(sellerTargets.period, period))),
    live.length === 0 ? Promise.resolve([]) : db.select().from(commissionRates).where(inArray(commissionRates.sellerId, live)),
    actualsForMany(db, live, period),
  ]);
  const targetBy = new Map(targets.map((t) => [t.sellerId, t]));
  const rateBy = new Map(rates.map((r) => [r.sellerId, r]));

  return sellers.map((seller) => {
    const snapshot = frozen.get(seller.id);
    if (snapshot) {
      return {
        seller: { id: seller.id, name: seller.name }, period,
        goals: snapshot.goals as TargetGoals | null,
        progress: snapshot.progress as TargetProgress,
        behindPace: false,
        base: snapshot.base as Money,
        rate: snapshot.ratePercent,
        commission: snapshot.commission as Money | null,
        final: true,
      };
    }
    const target = targetBy.get(seller.id);
    const goals = target ? goalsOf(target) : null;
    const figures = actuals.get(seller.id);
    const progress = targetProgress(goals ?? {}, figures ?? { REVENUE: '0.00', PACKS_SOLD: '0', NEW_STORES: '0', COLLECTED: '0.00' });
    const rate = rateBy.get(seller.id);
    const result = commissionFor(
      (figures?.COLLECTED ?? '0.00') as Money,
      figures?.creditAgainstOtherDebts ?? ('0.00' as Money),
      progress.met,
      rate ? { onTarget: rate.onTargetPercent, belowTarget: rate.belowTargetPercent } : null,
    );
    return {
      seller: { id: seller.id, name: seller.name }, period, goals, progress,
      behindPace: isBehindPace(progress, elapsedInPeriod(period, now), daysInPeriod(period), settings['targets.pace_threshold_percent']),
      base: result.base, rate: result.rate, commission: result.commission,
      final: isFrozen(period, settings['period.close_after_days'], now),
    };
  });
}

/** One seller's standing. */
export async function standingFor(db: Executor, sellerId: string, name: string, period: string, now: Date): Promise<TargetStanding> {
  const [only] = await standingsFor(db, [{ id: sellerId, name }], period, now);
  if (!only) throw new DomainError('NOT_FOUND', { sellerId, period });
  return only;
}

/** TGT-004, COM-007: a seller's own month. Never anybody else's. */
export async function myStanding(ctx: Ctx, period?: string): Promise<TargetStanding> {
  authorize(ctx, 'targets.view_own');
  const db = ctx.tx ?? getDb();
  const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, ctx.user.id));
  return standingFor(db, ctx.user.id, me?.name ?? '', period ?? businessMonth(ctx.now), ctx.now);
}

/** COM-007: managers see the sellers their permissions cover; sellers see only themselves. */
export async function listStandings(ctx: Ctx, period?: string): Promise<TargetStanding[]> {
  authorize(ctx, 'targets.view_commission');
  const db = ctx.tx ?? getDb();
  const month = period ?? businessMonth(ctx.now);
  const sellers = ctx.permissions.has('targets.manage')
    ? await db.select({ id: users.id, name: users.name }).from(users)
      .where(and(eq(users.role, 'SELLER'), eq(users.status, 'ACTIVE'))).orderBy(asc(users.name))
    : await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, ctx.user.id));
  return standingsFor(db, sellers, month, ctx.now);
}

/** The months a seller has a frozen snapshot for, newest first (COM-004). */
export async function listPeriods(ctx: Ctx, sellerId?: string): Promise<{ period: string; final: boolean }[]> {
  authorize(ctx, 'targets.view_commission');
  const db = ctx.tx ?? getDb();
  const id = sellerId ?? ctx.user.id;
  if (id !== ctx.user.id && !ctx.permissions.has('targets.manage')) throw new DomainError('FORBIDDEN', { sellerId });
  const rows = await db.select({ period: commissionPeriods.period }).from(commissionPeriods)
    .where(eq(commissionPeriods.sellerId, id)).orderBy(desc(commissionPeriods.period));
  const current = businessMonth(ctx.now);
  const months = rows.map((r) => ({ period: r.period, final: true }));
  return months.some((m) => m.period === current) ? months : [{ period: current, final: false }, ...months];
}
