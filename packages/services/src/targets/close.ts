import {
  businessMonth, daysInPeriod, elapsedInPeriod, freezesAt, isBehindPace, type UserId,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, asc, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { notify } from '../notifications';
import { inTx } from '../platform';
import { defaultBranchId, getDb } from '../runtime';
import { readSettings } from '../system';
import { standingsFor } from './targets';

const { commissionPeriods, sellerTargets, users } = schema;

/** The months that may still be waiting for a snapshot: this one and the few before it. */
function recentPeriods(now: Date, count = 4): string[] {
  const out: string[] = [];
  const cursor = new Date(now);
  for (let i = 0; i < count; i += 1) {
    out.push(businessMonth(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() - 1, 1);
  }
  return out;
}

/**
 * TGT-005, COM-008 (ADR-0042): a few days after a month ends it freezes. Every
 * seller's figures are written once, as they stood, and everything afterwards
 * reads that snapshot rather than recomputing — which is what makes a
 * commission figure safe to pay against. Sellers who missed a target they were
 * set are told, and so are the managers who can see it.
 *
 * Runs daily. Writing a snapshot that already exists is refused by a unique
 * index, so a second run the same day changes nothing.
 */
export async function closePeriods(ctx: Ctx): Promise<{ frozen: number; missed: number }> {
  const db = ctx.tx ?? getDb();
  const closeAfterDays = (await readSettings(db))['period.close_after_days'];
  const sellers = await db.select({ id: users.id, name: users.name }).from(users)
    .where(and(eq(users.role, 'SELLER'), eq(users.status, 'ACTIVE'))).orderBy(asc(users.name));
  if (sellers.length === 0) return { frozen: 0, missed: 0 };

  let frozen = 0;
  let missed = 0;
  for (const period of recentPeriods(ctx.now)) {
    if (ctx.now < freezesAt(period, closeAfterDays)) continue;
    const done = await db.select({ sellerId: commissionPeriods.sellerId }).from(commissionPeriods)
      .where(eq(commissionPeriods.period, period));
    const pending = sellers.filter((s) => !done.some((d) => d.sellerId === s.id));
    if (pending.length === 0) continue;
    // One pass for the whole month, not one per seller.
    const standings = await standingsFor(db, pending, period, ctx.now);
    for (const standing of standings) {
      const wasMissed = Boolean(standing.goals) && !standing.progress.met;
      await inTx(ctx, async (tx) => {
        await tx.insert(commissionPeriods).values({
          id: newId(), sellerId: standing.seller.id, period, frozenAt: freezesAt(period, closeAfterDays),
          goals: standing.goals, progress: standing.progress,
          met: standing.goals ? standing.progress.met : null,
          base: standing.base, ratePercent: standing.rate, commission: standing.commission,
          branchId: ctx.branchId,
        }).onConflictDoNothing();
        // TGT-005: a target that was set and not reached is worth saying out loud, once.
        if (wasMissed) {
          await notify(tx, ctx, { users: [standing.seller.id], includeActor: true }, 'TARGET_MISSED', { period }, '/field/targets');
          await notify(tx, ctx, { permission: 'targets.view_commission' }, 'TARGET_MISSED', { period, name: standing.seller.name }, '/console/targets');
        }
      });
      frozen += 1;
      if (wasMissed) missed += 1;
    }
  }
  return { frozen, missed };
}

/**
 * TGT-006: mid-month, a seller far enough behind the pace their target needs is
 * told, and so are the managers. Runs daily; the notification carries the month,
 * so a seller who stays behind is not told twice for the same day's work.
 */
export async function checkPace(ctx: Ctx): Promise<{ warned: number }> {
  const db = ctx.tx ?? getDb();
  const settings = await readSettings(db);
  const period = businessMonth(ctx.now);
  const targets = await db.select({ sellerId: sellerTargets.sellerId, name: users.name }).from(sellerTargets)
    .innerJoin(users, eq(users.id, sellerTargets.sellerId))
    .where(and(eq(sellerTargets.period, period), eq(users.status, 'ACTIVE')));

  let warned = 0;
  const standings = await standingsFor(db, targets.map((t) => ({ id: t.sellerId, name: t.name })), period, ctx.now);
  for (const standing of standings) {
    if (!isBehindPace(standing.progress, elapsedInPeriod(period, ctx.now), daysInPeriod(period), settings['targets.pace_threshold_percent'])) continue;
    await inTx(ctx, async (tx) => {
      await notify(tx, ctx, { users: [standing.seller.id], includeActor: true }, 'TARGET_BEHIND_PACE', { period }, '/field/targets');
      await notify(tx, ctx, { permission: 'targets.view_commission' }, 'TARGET_BEHIND_PACE', { period, name: standing.seller.name }, '/console/targets');
    });
    warned += 1;
  }
  return { warned };
}

const workerCtx = async (now: Date): Promise<Ctx> => ({
  user: { id: '00000000-0000-4000-8000-000000000000' as UserId, role: 'ADMIN' },
  permissions: new Set(), now, requestId: 'worker', locale: 'en', branchId: await defaultBranchId(), ip: null,
});

export const sweepPeriods = async (now: Date) => closePeriods(await workerCtx(now));
export const sweepPace = async (now: Date) => checkPace(await workerCtx(now));
