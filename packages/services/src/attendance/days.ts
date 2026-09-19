import {
  activeMs, assertLocation, businessDate, checkInOdometerFlags, checkOutOdometerFlags, DomainError, odometerReading,
  sessionDistanceKm, transitionDay, zoneCheck,
  type AttendanceDayStatus, type AttendanceSessionStatus, type GeoPoint, type OdometerFlag,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, desc, eq, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { assertOwnEvidence } from '../media';
import { notify } from '../notifications';
import { audit, inTx, type Executor, type Tx } from '../platform';
import { getDb } from '../runtime';
import { readSettings, readToggles } from '../system';
import { currentAssignment, lastOdometer, liveSession } from './guard';

const { attendanceDays, attendanceSessions, attendanceBreaks, odometerReadings, checkInZones, vehicles, closingStockDeclarations } = schema;

export type Capture = {
  readonly location: GeoPoint & { readonly accuracyM?: number | null | undefined };
  readonly selfieId: string;
  readonly odometer?: number | null | undefined;
  readonly odometerPhotoId?: string | null | undefined;
};

export type SessionView = {
  readonly id: string; readonly status: AttendanceSessionStatus; readonly checkedInAt: Date; readonly checkedOutAt: Date | null;
  readonly checkInOdometer: number | null; readonly checkOutOdometer: number | null; readonly distanceKm: number | null;
  readonly activeMs: number; readonly breaks: readonly { readonly startedAt: Date; readonly endedAt: Date | null }[];
  readonly flags: readonly OdometerFlag[]; readonly reviewed: boolean; readonly reviewComment: string | null;
  readonly openedOnBehalf: boolean; readonly onBehalfReason: string | null;
  /** ATT-012: the evidence a manager checks a flagged reading against. */
  readonly photos: { readonly checkInSelfie: string | null; readonly checkInOdometer: string | null; readonly checkOutSelfie: string | null; readonly checkOutOdometer: string | null };
};

export type Today = {
  readonly day: {
    readonly id: string; readonly workDate: string; readonly status: AttendanceDayStatus;
    readonly vehicle: { readonly id: string; readonly registration: string } | null;
  } | null;
  readonly sessions: readonly SessionView[];
  /** The session being worked or waiting on authorisation. */ readonly live: SessionView | null;
  readonly totals: { readonly activeMs: number; readonly distanceKm: number | null };
  readonly assignedVehicle: { readonly id: string; readonly registration: string; readonly lastOdometer: number | null } | null;
  readonly breaksEnabled: boolean;
  readonly closingDeclared: boolean;
};

/** Sessions with their breaks, in order, for a set of days. */
export async function sessionsFor(db: Executor, dayIds: readonly string[], now: Date): Promise<Map<string, SessionView[]>> {
  if (dayIds.length === 0) return new Map();
  const rows = await db.select().from(attendanceSessions)
    .where(and(inArray(attendanceSessions.dayId, [...dayIds]), ne(attendanceSessions.status, 'WITHDRAWN')))
    .orderBy(asc(attendanceSessions.checkedInAt));
  const breaks = rows.length === 0 ? [] : await db.select().from(attendanceBreaks)
    .where(inArray(attendanceBreaks.sessionId, rows.map((r) => r.id))).orderBy(asc(attendanceBreaks.startedAt));
  const out = new Map<string, SessionView[]>();
  for (const r of rows) {
    const own = breaks.filter((b) => b.sessionId === r.id).map((b) => ({ startedAt: b.startedAt, endedAt: b.endedAt }));
    const distanceKm = sessionDistanceKm(r.checkInOdometer, r.checkOutOdometer);
    const span = { from: r.checkedInAt, to: r.checkedOutAt, distanceKm, breaks: own.map((b) => ({ from: b.startedAt, to: b.endedAt })) };
    const list = out.get(r.dayId) ?? [];
    list.push({
      id: r.id, status: r.status, checkedInAt: r.checkedInAt, checkedOutAt: r.checkedOutAt,
      checkInOdometer: r.checkInOdometer, checkOutOdometer: r.checkOutOdometer, distanceKm,
      // Waiting on authorisation is not working time.
      activeMs: r.status === 'AWAITING_AUTHORISATION' ? 0 : activeMs(span, now), breaks: own,
      flags: [...r.checkInFlags, ...r.checkOutFlags], reviewed: r.reviewedAt !== null, reviewComment: r.reviewComment,
      openedOnBehalf: r.openedOnBehalfBy !== null, onBehalfReason: r.onBehalfReason,
      photos: { checkInSelfie: r.checkInSelfieId, checkInOdometer: r.checkInOdoPhotoId, checkOutSelfie: r.checkOutSelfieId, checkOutOdometer: r.checkOutOdoPhotoId },
    });
    out.set(r.dayId, list);
  }
  return out;
}

export const totalsOf = (sessions: readonly SessionView[]) => {
  const distances = sessions.map((s) => s.distanceKm).filter((d): d is number => d !== null);
  return { activeMs: sessions.reduce((sum, s) => sum + s.activeMs, 0), distanceKm: distances.length ? distances.reduce((a, b) => a + b, 0) : null };
};

/** The seller's day: the live one (perhaps begun yesterday) or today's. */
export async function getToday(ctx: Ctx): Promise<Today> {
  authorize(ctx, 'attendance.self');
  // After a check-in, the request's own transaction holds rows no other connection can see yet.
  const db = ctx.tx ?? getDb();
  const live = await liveSession(db, ctx.user.id);
  const today = businessDate(ctx.now);
  const dayFor = (where: SQL) => db.select({ day: attendanceDays, registration: vehicles.registration }).from(attendanceDays)
    .leftJoin(vehicles, eq(vehicles.id, attendanceDays.vehicleId))
    .where(and(eq(attendanceDays.sellerId, ctx.user.id), where)).orderBy(desc(attendanceDays.workDate)).limit(1);
  const [current] = await dayFor(eq(attendanceDays.workDate, live?.workDate ?? today));
  const assignment = await currentAssignment(db, ctx.user.id);
  const toggles = await readToggles(db);
  // A trip that ended this morning still shows until the day is closed overnight.
  const [day] = current || live ? [current] : await dayFor(and(eq(attendanceDays.status, 'CHECKED_OUT'), lt(attendanceDays.workDate, today)) as SQL);
  const workDate = day?.day.workDate ?? today;
  const sessions = day ? ((await sessionsFor(db, [day.day.id], ctx.now)).get(day.day.id) ?? []) : [];
  const [declared] = await db.select({ id: closingStockDeclarations.id }).from(closingStockDeclarations)
    .where(and(eq(closingStockDeclarations.sellerId, ctx.user.id), eq(closingStockDeclarations.workDate, workDate)));
  return {
    day: day ? {
      id: day.day.id, workDate: day.day.workDate, status: day.day.status,
      vehicle: day.day.vehicleId && day.registration ? { id: day.day.vehicleId, registration: day.registration } : null,
    } : null,
    sessions, live: sessions.find((s) => s.id === live?.sessionId) ?? null, totals: totalsOf(sessions),
    assignedVehicle: assignment ? { id: assignment.vehicleId, registration: assignment.registration, lastOdometer: await lastOdometer(db, assignment.vehicleId) } : null,
    breaksEnabled: toggles['attendance.break_logging'], closingDeclared: declared !== undefined,
  };
}

/** One seller's attendance changes one at a time. */
const lockSeller = (tx: Tx, sellerId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`attendance:${sellerId}`}, 0))`);

async function odometerCapture(tx: Tx, ctx: Ctx, input: Capture): Promise<{ reading: number; photoId: string }> {
  if (input.odometer === null || input.odometer === undefined || !input.odometerPhotoId) throw new DomainError('ODOMETER_REQUIRED');
  await assertOwnEvidence(tx, ctx, input.odometerPhotoId, 'ODOMETER');
  return { reading: odometerReading(input.odometer), photoId: input.odometerPhotoId };
}

const coords = (p: GeoPoint & { accuracyM?: number | null | undefined }) => ({
  lat: p.lat.toFixed(6), lng: p.lng.toFixed(6), accuracy: p.accuracyM === null || p.accuracyM === undefined ? null : p.accuracyM.toFixed(1),
});

/**
 * Workflow G step 1 (ATT-001, 004, 005, 007, 008, 012): selfie, location and —
 * with a vehicle — odometer photo and reading. A second check-in the same day
 * is a split shift. Outside every zone, with restriction on, the session waits
 * for a manager (ATT-009). Odometer doubts are flagged, never refused.
 */
export async function checkIn(ctx: Ctx, input: Capture & { withoutVehicle?: boolean | undefined }): Promise<Today> {
  authorize(ctx, 'attendance.self');
  const location = assertLocation(input.location);
  await inTx(ctx, async (tx) => {
    await lockSeller(tx, ctx.user.id);
    await assertOwnEvidence(tx, ctx, input.selfieId, 'SELFIE');
    const live = await liveSession(tx, ctx.user.id);
    if (live && !live.awaitingAuthorisation) throw new DomainError('ALREADY_CHECKED_IN');
    if (live) await withdraw(tx, ctx, live.sessionId);

    const assignment = input.withoutVehicle ? null : await currentAssignment(tx, ctx.user.id);
    const odometer = assignment ? await odometerCapture(tx, ctx, input) : null;
    const settings = await readSettings(tx);
    const toggles = await readToggles(tx);
    const zones = await tx.select().from(checkInZones).where(eq(checkInZones.isActive, true));
    const previous = assignment ? await lastOdometer(tx, assignment.vehicleId) : null;
    const flags = odometer ? checkInOdometerFlags(previous, odometer.reading, settings['attendance.odometer_tolerance_km']) : [];
    const zone = zoneCheck(location, input.location.accuracyM ?? null, zones.map((z) => ({ id: z.id, lat: Number(z.lat), lng: Number(z.lng), radiusM: z.radiusM })), toggles['attendance.restricted_check_in']);

    const workDate = live?.workDate ?? businessDate(ctx.now);
    const [existing] = await tx.select().from(attendanceDays).where(and(eq(attendanceDays.sellerId, ctx.user.id), eq(attendanceDays.workDate, workDate)));
    let dayId: string;
    if (existing) {
      // A split shift — or a fresh attempt after a withdrawn one.
      const status = transitionDay(existing.status, 'check_in');
      await tx.update(attendanceDays).set({
        status, vehicleId: existing.vehicleId ?? assignment?.vehicleId ?? null, updatedAt: ctx.now, updatedBy: ctx.user.id, version: existing.version + 1,
      }).where(eq(attendanceDays.id, existing.id));
      dayId = existing.id;
    } else {
      const [created] = await tx.insert(attendanceDays).values({
        sellerId: ctx.user.id, workDate, vehicleId: assignment?.vehicleId ?? null, status: transitionDay(null, 'check_in'),
        openedBy: ctx.user.id, branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
      }).returning({ id: attendanceDays.id });
      if (!created) throw new Error('attendance day insert returned nothing');
      dayId = created.id;
    }

    const c = coords(input.location);
    const [session] = await tx.insert(attendanceSessions).values({
      dayId, sellerId: ctx.user.id, status: zone.inside ? 'OPEN' : 'AWAITING_AUTHORISATION', checkedInAt: ctx.now,
      checkInLat: c.lat, checkInLng: c.lng, checkInAccuracyM: c.accuracy, checkInSelfieId: input.selfieId,
      checkInOdoPhotoId: odometer?.photoId ?? null, checkInOdometer: odometer?.reading ?? null, checkInFlags: flags,
      checkInZoneId: zone.zoneId, branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: attendanceSessions.id });
    if (!session) throw new Error('attendance session insert returned nothing');
    if (assignment && odometer) {
      await tx.insert(odometerReadings).values({
        vehicleId: assignment.vehicleId, readingKm: odometer.reading, source: 'CHECK_IN', sessionId: session.id, photoId: odometer.photoId,
        recordedAt: ctx.now, recordedBy: ctx.user.id, branchId: ctx.branchId,
      });
    }
    if (!zone.inside) {
      await notify(tx, ctx, { permission: 'attendance.manage' }, 'CHECK_IN_AWAITING_AUTHORISATION', { sessionId: session.id }, '/console/attendance');
    }
    await audit(tx, ctx, {
      action: 'attendance.checked_in', entityType: 'attendance_session', entityId: session.id,
      after: { workDate, vehicleId: assignment?.vehicleId ?? null, odometer: odometer?.reading ?? null, flags, inside: zone.inside, zoneId: zone.zoneId },
    });
  });
  return getToday(ctx);
}

/** A waiting check-in replaced by a new attempt, or left past its day. */
export async function withdraw(tx: Tx, ctx: Ctx, sessionId: string): Promise<void> {
  const [row] = await tx.update(attendanceSessions)
    .set({ status: 'WITHDRAWN', updatedAt: ctx.now, updatedBy: ctx.user.id, version: sql`${attendanceSessions.version} + 1` })
    .where(and(eq(attendanceSessions.id, sessionId), eq(attendanceSessions.status, 'AWAITING_AUTHORISATION')))
    .returning({ dayId: attendanceSessions.dayId });
  if (!row) return;
  await audit(tx, ctx, { action: 'attendance.check_in_withdrawn', entityType: 'attendance_session', entityId: sessionId });
  // Nothing was worked in it: the day is as if the attempt never happened.
  await tx.update(attendanceDays).set({ status: 'CHECKED_OUT', updatedAt: ctx.now, updatedBy: ctx.user.id, version: sql`${attendanceDays.version} + 1` })
    .where(eq(attendanceDays.id, row.dayId));
}

/**
 * Workflow G step 7 (ATT-001, 002): the same capture again. Distance is the
 * odometer difference against the vehicle; a doubtful figure is flagged.
 * Checking out on a break ends the break.
 */
export async function checkOut(ctx: Ctx, input: Capture): Promise<Today> {
  authorize(ctx, 'attendance.self');
  assertLocation(input.location);
  await inTx(ctx, async (tx) => {
    await lockSeller(tx, ctx.user.id);
    await assertOwnEvidence(tx, ctx, input.selfieId, 'SELFIE');
    const live = await liveSession(tx, ctx.user.id);
    if (!live) throw new DomainError('NOT_CHECKED_IN');
    if (live.awaitingAuthorisation) throw new DomainError('ZONE_AUTHORISATION_PENDING');
    const [session] = await tx.select().from(attendanceSessions).where(eq(attendanceSessions.id, live.sessionId));
    const [day] = await tx.select().from(attendanceDays).where(eq(attendanceDays.id, live.dayId));
    if (!session || !day) throw new Error('live session vanished');
    const status = transitionDay(day.status, 'check_out');

    const odometer = day.vehicleId ? await odometerCapture(tx, ctx, input) : null;
    const settings = await readSettings(tx);
    const base = session.checkInOdometer ?? (day.vehicleId ? await lastOdometer(tx, day.vehicleId) : null);
    const flags = odometer ? checkOutOdometerFlags(base, odometer.reading, settings['attendance.max_session_km']) : [];

    await tx.update(attendanceBreaks).set({ endedAt: ctx.now }).where(and(eq(attendanceBreaks.sessionId, session.id), isNull(attendanceBreaks.endedAt)));
    const c = coords(input.location);
    await tx.update(attendanceSessions).set({
      status: 'CLOSED', checkedOutAt: ctx.now, checkOutLat: c.lat, checkOutLng: c.lng, checkOutAccuracyM: c.accuracy,
      checkOutSelfieId: input.selfieId, checkOutOdoPhotoId: odometer?.photoId ?? null, checkOutOdometer: odometer?.reading ?? null,
      checkOutFlags: flags, updatedAt: ctx.now, updatedBy: ctx.user.id, version: session.version + 1,
    }).where(eq(attendanceSessions.id, session.id));
    if (day.vehicleId && odometer) {
      await tx.insert(odometerReadings).values({
        vehicleId: day.vehicleId, readingKm: odometer.reading, source: 'CHECK_OUT', sessionId: session.id, photoId: odometer.photoId,
        recordedAt: ctx.now, recordedBy: ctx.user.id, branchId: ctx.branchId,
      });
    }
    await tx.update(attendanceDays).set({ status, updatedAt: ctx.now, updatedBy: ctx.user.id, version: day.version + 1 }).where(eq(attendanceDays.id, day.id));
    // TODO(M6): expire the seller's pending discount approval requests (PRC-015).
    await audit(tx, ctx, {
      action: 'attendance.checked_out', entityType: 'attendance_session', entityId: session.id,
      after: { odometer: odometer?.reading ?? null, distanceKm: sessionDistanceKm(session.checkInOdometer, odometer?.reading ?? null), flags },
    });
  });
  return getToday(ctx);
}

/** ATT-003: breaks, where the Admin has enabled them. */
export async function setBreak(ctx: Ctx, action: 'start' | 'end'): Promise<Today> {
  authorize(ctx, 'attendance.self');
  await inTx(ctx, async (tx) => {
    if (!(await readToggles(tx))['attendance.break_logging']) throw new DomainError('FEATURE_DISABLED', { feature: 'attendance.break_logging' });
    await lockSeller(tx, ctx.user.id);
    const live = await liveSession(tx, ctx.user.id);
    if (!live) throw new DomainError('NOT_CHECKED_IN');
    if (live.awaitingAuthorisation) throw new DomainError('ZONE_AUTHORISATION_PENDING');
    const [day] = await tx.select().from(attendanceDays).where(eq(attendanceDays.id, live.dayId));
    if (!day) throw new Error('live day vanished');
    const status = transitionDay(day.status, action === 'start' ? 'start_break' : 'end_break');
    if (action === 'start') await tx.insert(attendanceBreaks).values({ sessionId: live.sessionId, startedAt: ctx.now });
    else await tx.update(attendanceBreaks).set({ endedAt: ctx.now }).where(and(eq(attendanceBreaks.sessionId, live.sessionId), isNull(attendanceBreaks.endedAt)));
    await tx.update(attendanceDays).set({ status, updatedAt: ctx.now, updatedBy: ctx.user.id, version: day.version + 1 }).where(eq(attendanceDays.id, day.id));
    await audit(tx, ctx, { action: action === 'start' ? 'attendance.break_started' : 'attendance.break_ended', entityType: 'attendance_session', entityId: live.sessionId });
  });
  return getToday(ctx);
}
