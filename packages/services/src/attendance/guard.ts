import { assertWorking, DomainError, type AttendanceDayStatus, type StockAccount } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { Executor, Tx } from '../platform';

const { vehicleAssignments, vehicles, attendanceDays, attendanceSessions, odometerReadings } = schema;

/** One seller's attendance changes one at a time — their own, a manager's on their behalf, or their vehicle taken back. */
export const lockAttendance = (tx: Tx, sellerId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`attendance:${sellerId}`}, 0))`);

/** VEH-002: the vehicle a seller holds now, if any, and since when. */
export async function currentAssignment(db: Executor, sellerId: string): Promise<{ id: string; vehicleId: string; registration: string; startedAt: Date } | null> {
  const [row] = await db.select({ id: vehicleAssignments.id, vehicleId: vehicleAssignments.vehicleId, registration: vehicles.registration, startedAt: vehicleAssignments.startedAt })
    .from(vehicleAssignments).innerJoin(vehicles, eq(vehicles.id, vehicleAssignments.vehicleId))
    .where(and(eq(vehicleAssignments.sellerId, sellerId), isNull(vehicleAssignments.endedAt)));
  return row ?? null;
}

/** VEH-004: the vehicle's latest reading, whoever took it. */
export async function lastOdometer(db: Executor, vehicleId: string): Promise<number | null> {
  const [row] = await db.select({ km: odometerReadings.readingKm }).from(odometerReadings)
    .where(eq(odometerReadings.vehicleId, vehicleId)).orderBy(desc(odometerReadings.recordedAt), desc(odometerReadings.createdAt)).limit(1);
  return row?.km ?? null;
}

export type LiveDay = {
  readonly dayId: string; readonly workDate: string; readonly status: AttendanceDayStatus;
  /** The trip's vehicle: the one assigned at its check-in (ATT-014). */ readonly vehicleId: string | null;
  readonly sessionId: string; readonly checkedInAt: Date; readonly awaitingAuthorisation: boolean;
};

/**
 * The session a seller is working in or waiting on — at most one (a unique
 * index keeps it so). It may have started yesterday: a multi-day trip.
 */
export async function liveSession(db: Executor, sellerId: string): Promise<LiveDay | null> {
  const [row] = await db.select({ session: attendanceSessions, day: attendanceDays }).from(attendanceSessions)
    .innerJoin(attendanceDays, eq(attendanceDays.id, attendanceSessions.dayId))
    .where(and(eq(attendanceSessions.sellerId, sellerId), inArray(attendanceSessions.status, ['OPEN', 'AWAITING_AUTHORISATION'])));
  if (!row) return null;
  return {
    dayId: row.day.id, workDate: row.day.workDate, status: row.day.status, vehicleId: row.session.vehicleId,
    sessionId: row.session.id, checkedInAt: row.session.checkedInAt, awaitingAuthorisation: row.session.status === 'AWAITING_AUTHORISATION',
  };
}

/** VEH-016 (ADR-0056): the seller's live trip, if it is with this vehicle — checked in with it and not out yet. */
export async function tripWith(db: Executor, sellerId: string, vehicleId: string): Promise<LiveDay | null> {
  const live = await liveSession(db, sellerId);
  return live?.vehicleId === vehicleId ? live : null;
}

/**
 * ATT-010: the guard in front of every sale and stock movement by a seller.
 * Anyone else works from the console and has no field day to check.
 */
export async function assertSellerWorking(db: Executor, ctx: Ctx): Promise<LiveDay | null> {
  if (ctx.user.role !== 'SELLER') return null;
  const live = await liveSession(db, ctx.user.id);
  assertWorking(live);
  return live;
}

/**
 * A seller's stock account: the vehicle they checked in with on this trip,
 * still assigned to them (VEH-003, ATT-014), during an OPEN day (ATT-010). A
 * trip without a vehicle has no stock to act on (ATT-007).
 */
export async function sellerVehicleAccount(db: Executor, ctx: Ctx): Promise<StockAccount & { kind: 'VEHICLE' }> {
  const live = await assertSellerWorking(db, ctx);
  const assignment = await currentAssignment(db, ctx.user.id);
  if (!assignment) throw new DomainError('VEHICLE_NOT_ASSIGNED');
  if (!live?.vehicleId) throw new DomainError('NO_VEHICLE_TODAY');
  if (live.vehicleId !== assignment.vehicleId) throw new DomainError('VEHICLE_NOT_ASSIGNED', { vehicleId: live.vehicleId });
  return { kind: 'VEHICLE', vehicleId: assignment.vehicleId };
}
