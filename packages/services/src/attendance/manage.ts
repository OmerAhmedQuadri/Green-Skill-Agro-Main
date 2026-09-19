import {
  attributeByDay, businessDate, checkInOdometerFlags, DomainError, odometerReading, transitionDay,
  type AttendanceDayStatus, type DayShare,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, desc, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import { notify } from '../notifications';
import { audit, inTx, writeAudit, type Tx } from '../platform';
import { defaultBranchId, getDb } from '../runtime';
import { readSettings } from '../system';
import { sessionsFor, totalsOf, withdraw, type SessionView } from './days';
import { currentAssignment, lastOdometer, liveSession } from './guard';

const { attendanceDays, attendanceSessions, odometerReadings, users, vehicles } = schema;

/**
 * ATT-011: a seller missed their check-in — a manager opens the day for them,
 * with a reason. There is no selfie or location to capture; the manager may
 * enter the odometer. The seller is told.
 */
export async function openDayOnBehalf(ctx: Ctx, input: { sellerId: string; reason: string; odometer?: number | null | undefined }): Promise<{ sessionId: string }> {
  authorize(ctx, 'attendance.manage');
  const reason = input.reason.trim();
  if (!reason) throw new DomainError('REASON_REQUIRED', { action: 'open_day' });
  return inTx(ctx, async (tx) => {
    const [seller] = await tx.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, input.sellerId));
    if (seller?.role !== 'SELLER' || seller.status !== 'ACTIVE') throw new DomainError('NOT_FOUND', { entity: 'seller', id: input.sellerId });
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`attendance:${input.sellerId}`}, 0))`);
    const live = await liveSession(tx, input.sellerId);
    if (live && !live.awaitingAuthorisation) throw new DomainError('ALREADY_CHECKED_IN');
    if (live) await withdraw(tx, ctx, live.sessionId);

    const assignment = await currentAssignment(tx, input.sellerId);
    const reading = input.odometer === null || input.odometer === undefined || !assignment ? null : odometerReading(input.odometer);
    const settings = await readSettings(tx);
    const flags = reading === null || !assignment ? [] : checkInOdometerFlags(await lastOdometer(tx, assignment.vehicleId), reading, settings['attendance.odometer_tolerance_km']);

    const workDate = live?.workDate ?? businessDate(ctx.now);
    const [existing] = await tx.select().from(attendanceDays).where(and(eq(attendanceDays.sellerId, input.sellerId), eq(attendanceDays.workDate, workDate)));
    let dayId: string;
    if (existing) {
      await tx.update(attendanceDays).set({
        status: transitionDay(existing.status, 'check_in'), vehicleId: existing.vehicleId ?? assignment?.vehicleId ?? null,
        updatedAt: ctx.now, updatedBy: ctx.user.id, version: existing.version + 1,
      }).where(eq(attendanceDays.id, existing.id));
      dayId = existing.id;
    } else {
      const [created] = await tx.insert(attendanceDays).values({
        sellerId: input.sellerId, workDate, vehicleId: assignment?.vehicleId ?? null, status: 'OPEN', openedBy: ctx.user.id, openedReason: reason,
        branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
      }).returning({ id: attendanceDays.id });
      if (!created) throw new Error('attendance day insert returned nothing');
      dayId = created.id;
    }
    const [session] = await tx.insert(attendanceSessions).values({
      dayId, sellerId: input.sellerId, status: 'OPEN', checkedInAt: ctx.now, checkInOdometer: reading, checkInFlags: flags,
      openedOnBehalfBy: ctx.user.id, onBehalfReason: reason, branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: attendanceSessions.id });
    if (!session) throw new Error('attendance session insert returned nothing');
    if (reading !== null && assignment) {
      await tx.insert(odometerReadings).values({
        vehicleId: assignment.vehicleId, readingKm: reading, source: 'CHECK_IN', sessionId: session.id,
        recordedAt: ctx.now, recordedBy: ctx.user.id, branchId: ctx.branchId,
      });
    }
    await notify(tx, ctx, { users: [input.sellerId] }, 'DAY_OPENED_ON_BEHALF', { reason }, '/field/today');
    await audit(tx, ctx, { action: 'attendance.day_opened_on_behalf', entityType: 'attendance_session', entityId: session.id, after: { sellerId: input.sellerId, workDate, reason, odometer: reading } });
    return { sessionId: session.id };
  });
}

async function sessionForUpdate(tx: Tx, id: string) {
  const [row] = await tx.select().from(attendanceSessions).where(eq(attendanceSessions.id, id)).for('update');
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'attendance_session', id });
  return row;
}

/** ATT-009: the seller is legitimately elsewhere; the waiting check-in opens. */
export async function authoriseZone(ctx: Ctx, sessionId: string): Promise<void> {
  authorize(ctx, 'attendance.manage');
  await inTx(ctx, async (tx) => {
    const session = await sessionForUpdate(tx, sessionId);
    if (session.status !== 'AWAITING_AUTHORISATION') throw new DomainError('ALREADY_DECIDED', { status: session.status });
    await tx.update(attendanceSessions).set({
      status: 'OPEN', zoneAuthorisedBy: ctx.user.id, zoneAuthorisedAt: ctx.now, updatedAt: ctx.now, updatedBy: ctx.user.id, version: session.version + 1,
    }).where(eq(attendanceSessions.id, sessionId));
    await notify(tx, ctx, { users: [session.sellerId] }, 'CHECK_IN_AUTHORISED', {}, '/field/today');
    await audit(tx, ctx, { action: 'attendance.zone_authorised', entityType: 'attendance_session', entityId: sessionId });
  });
}

/** ATT-012: a manager looks at a flagged odometer reading and records what they found. */
export async function reviewSession(ctx: Ctx, sessionId: string, input: { comment: string }): Promise<void> {
  authorize(ctx, 'attendance.manage');
  const comment = input.comment.trim();
  if (!comment) throw new DomainError('REASON_REQUIRED', { action: 'review' });
  await inTx(ctx, async (tx) => {
    const session = await sessionForUpdate(tx, sessionId);
    if (session.checkInFlags.length + session.checkOutFlags.length === 0) throw new DomainError('INVALID_TRANSITION', { reason: 'NOT_FLAGGED' });
    if (session.reviewedAt) throw new DomainError('ALREADY_DECIDED');
    await tx.update(attendanceSessions).set({
      reviewedAt: ctx.now, reviewedBy: ctx.user.id, reviewComment: comment, updatedAt: ctx.now, updatedBy: ctx.user.id, version: session.version + 1,
    }).where(eq(attendanceSessions.id, sessionId));
    await audit(tx, ctx, { action: 'attendance.flag_reviewed', entityType: 'attendance_session', entityId: sessionId, after: { comment } });
  });
}

export type AttendanceDay = {
  readonly id: string; readonly workDate: string; readonly status: AttendanceDayStatus;
  readonly seller: { readonly id: string; readonly name: string };
  readonly vehicle: { readonly id: string; readonly registration: string } | null;
  readonly openedOnBehalf: boolean;
  readonly sessions: readonly (SessionView & { readonly awaitingAuthorisation: boolean })[];
  readonly totals: { readonly activeMs: number; readonly distanceKm: number | null };
  /** OQ-004: set when a session runs past midnight — its hours and distance by day. */ readonly attribution: readonly DayShare[] | null;
  readonly needsAttention: boolean;
};

/** Attendance, distance and active hours (`attendance.view`; a manager acting on it sees it too), newest first. */
export async function listAttendance(
  ctx: Ctx, filter: { from?: string | undefined; to?: string | undefined; sellerId?: string | undefined; attention?: boolean | undefined } = {},
): Promise<AttendanceDay[]> {
  authorizeAny(ctx, ['attendance.view', 'attendance.manage']);
  const db = getDb();
  const to = filter.to ?? businessDate(ctx.now);
  const from = filter.from ?? to;
  const where: SQL[] = [gte(attendanceDays.workDate, from), lte(attendanceDays.workDate, to)];
  if (filter.sellerId) where.push(eq(attendanceDays.sellerId, filter.sellerId));
  const rows = await db.select({ day: attendanceDays, seller: users.name, registration: vehicles.registration }).from(attendanceDays)
    .innerJoin(users, eq(users.id, attendanceDays.sellerId)).leftJoin(vehicles, eq(vehicles.id, attendanceDays.vehicleId))
    .where(and(...where)).orderBy(desc(attendanceDays.workDate), asc(users.name)).limit(500);
  const sessions = await sessionsFor(db, rows.map((r) => r.day.id), ctx.now);
  const out = rows.map((r) => {
    const own = (sessions.get(r.day.id) ?? []).map((s) => ({ ...s, awaitingAuthorisation: s.status === 'AWAITING_AUTHORISATION' }));
    const crossing = own.filter((s) => businessDate(s.checkedOutAt ?? ctx.now) !== r.day.workDate && s.status !== 'AWAITING_AUTHORISATION');
    const attribution = crossing.length === 0 ? null : crossing.flatMap((s) => attributeByDay(
      { from: s.checkedInAt, to: s.checkedOutAt, distanceKm: s.distanceKm, breaks: s.breaks.map((b) => ({ from: b.startedAt, to: b.endedAt })) }, ctx.now));
    return {
      id: r.day.id, workDate: r.day.workDate, status: r.day.status, seller: { id: r.day.sellerId, name: r.seller },
      vehicle: r.day.vehicleId && r.registration ? { id: r.day.vehicleId, registration: r.registration } : null,
      openedOnBehalf: r.day.openedBy !== r.day.sellerId, sessions: own, totals: totalsOf(own), attribution,
      needsAttention: own.some((s) => s.awaitingAuthorisation || (s.flags.length > 0 && !s.reviewed)),
    };
  });
  return filter.attention ? out.filter((d) => d.needsAttention) : out;
}

/**
 * Worker job `attendance.close-day`, 03:00 Riyadh (STATE-MACHINES §10):
 * earlier checked-out days close; a check-in still waiting on a manager from
 * an earlier day is withdrawn. A session still open is a multi-day trip and
 * stays open. Idempotent.
 */
export async function closeFinishedDays(now: Date): Promise<{ closed: number; withdrawn: number }> {
  const today = businessDate(now);
  const result = await getDb().transaction(async (tx) => {
    const earlier = tx.select({ id: attendanceDays.id }).from(attendanceDays).where(lt(attendanceDays.workDate, today));
    const withdrawn = await tx.update(attendanceSessions).set({ status: 'WITHDRAWN', updatedAt: now, version: sql`${attendanceSessions.version} + 1` })
      .where(and(eq(attendanceSessions.status, 'AWAITING_AUTHORISATION'), inArray(attendanceSessions.dayId, earlier)))
      .returning({ dayId: attendanceSessions.dayId });
    if (withdrawn.length > 0) {
      await tx.update(attendanceDays).set({ status: 'CHECKED_OUT', updatedAt: now, version: sql`${attendanceDays.version} + 1` })
        .where(inArray(attendanceDays.id, withdrawn.map((w) => w.dayId)));
    }
    const closed = await tx.update(attendanceDays)
      .set({ status: 'CLOSED', closedAt: now, updatedAt: now, version: sql`${attendanceDays.version} + 1` })
      .where(and(eq(attendanceDays.status, 'CHECKED_OUT'), lt(attendanceDays.workDate, today)))
      .returning({ id: attendanceDays.id });
    if (closed.length + withdrawn.length > 0) {
      await writeAudit(tx, { actorId: null, branchId: await defaultBranchId(), requestId: null, ip: null }, {
        action: 'attendance.days_closed', entityType: 'attendance_day', after: { closed: closed.length, withdrawn: withdrawn.length, before: today },
      });
    }
    return { closed: closed.length, withdrawn: withdrawn.length };
  });
  return result;
}
