import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, numeric, pgEnum, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { mediaAssets } from './media';
import { mutable } from './mutable';
import { branches } from './organisation';
import { vehicles } from './vehicles';

// Mirror packages/core/src/attendance/attendance.ts.
export const attendanceDayStatus = pgEnum('attendance_day_status', ['OPEN', 'ON_BREAK', 'CHECKED_OUT', 'CLOSED']);
export const attendanceSessionStatus = pgEnum('attendance_session_status', ['AWAITING_AUTHORISATION', 'OPEN', 'CLOSED', 'WITHDRAWN']);
export const odometerFlag = pgEnum('odometer_flag', ['BELOW_PREVIOUS', 'GAP_FROM_PREVIOUS', 'BELOW_CHECK_IN', 'DISTANCE_IMPLAUSIBLE']);
export const odometerSource = pgEnum('odometer_source', ['REGISTRATION', 'CHECK_IN', 'CHECK_OUT', 'CORRECTION']);

const lat = (name: string) => numeric(name, { precision: 9, scale: 6 });
const lng = lat;

/** ATT-008 (ADR-0032): a circle a check-in may be restricted to, such as the warehouse yard. */
export const checkInZones = pgTable(
  'check_in_zones',
  {
    id: id(),
    name: text('name').notNull(),
    lat: lat('lat').notNull(),
    lng: lng('lng').notNull(),
    radiusM: integer('radius_m').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [check('check_in_zones_radius', sql`${t.radiusM} between 25 and 50000`)],
);

/**
 * DATA-MODEL §5.7: a day is the container, sessions are the events. The day
 * is the business date of its first check-in; no vehicle means a day without
 * one (ATT-007). Opened by a manager on the seller's behalf (ATT-011) when
 * `opened_by` is not the seller.
 */
export const attendanceDays = pgTable(
  'attendance_days',
  {
    id: id(),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    workDate: date('work_date').notNull(),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),
    status: attendanceDayStatus('status').notNull(),
    openedBy: uuid('opened_by').notNull().references(() => users.id),
    openedReason: text('opened_reason'),
    closedAt: timestamptz('closed_at'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    unique('attendance_days_one_per_date').on(t.sellerId, t.workDate),
    index('attendance_days_work_date_idx').on(t.workDate),
    index('attendance_days_vehicle_id_idx').on(t.vehicleId),
    check('attendance_days_on_behalf_reason', sql`${t.openedBy} = ${t.sellerId} or ${t.openedReason} is not null`),
  ],
);

/**
 * One check-in/check-out pair (ATT-001, ATT-005). Selfie and location are
 * required unless a manager opened the session on the seller's behalf.
 * Odometer readings live in `odometer_readings` as well, against the vehicle.
 */
export const attendanceSessions = pgTable(
  'attendance_sessions',
  {
    id: id(),
    dayId: uuid('day_id').notNull().references(() => attendanceDays.id),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    status: attendanceSessionStatus('status').notNull(),
    checkedInAt: timestamptz('checked_in_at').notNull(),
    checkInLat: lat('check_in_lat'),
    checkInLng: lng('check_in_lng'),
    checkInAccuracyM: numeric('check_in_accuracy_m', { precision: 8, scale: 1 }),
    checkInSelfieId: uuid('check_in_selfie_id').references(() => mediaAssets.id),
    checkInOdoPhotoId: uuid('check_in_odo_photo_id').references(() => mediaAssets.id),
    checkInOdometer: integer('check_in_odometer'),
    checkInFlags: odometerFlag('check_in_flags').array().notNull().default(sql`'{}'`),
    checkInZoneId: uuid('check_in_zone_id').references(() => checkInZones.id),
    openedOnBehalfBy: uuid('opened_on_behalf_by').references(() => users.id), // ATT-011
    onBehalfReason: text('on_behalf_reason'),
    zoneAuthorisedBy: uuid('zone_authorised_by').references(() => users.id), // ATT-009
    zoneAuthorisedAt: timestamptz('zone_authorised_at'),
    checkedOutAt: timestamptz('checked_out_at'),
    checkOutLat: lat('check_out_lat'),
    checkOutLng: lng('check_out_lng'),
    checkOutAccuracyM: numeric('check_out_accuracy_m', { precision: 8, scale: 1 }),
    checkOutSelfieId: uuid('check_out_selfie_id').references(() => mediaAssets.id),
    checkOutOdoPhotoId: uuid('check_out_odo_photo_id').references(() => mediaAssets.id),
    checkOutOdometer: integer('check_out_odometer'),
    checkOutFlags: odometerFlag('check_out_flags').array().notNull().default(sql`'{}'`),
    reviewedAt: timestamptz('reviewed_at'), // ATT-012
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewComment: text('review_comment'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    // ATT-010: at most one session a seller is working in, or waiting on.
    uniqueIndex('attendance_sessions_one_live').on(t.sellerId).where(sql`${t.status} in ('OPEN', 'AWAITING_AUTHORISATION')`),
    index('attendance_sessions_day_id_idx').on(t.dayId),
    index('attendance_sessions_checked_in_at_idx').on(t.checkedInAt),
    check('attendance_sessions_check_in_evidence', sql`${t.openedOnBehalfBy} is not null or (
      ${t.checkInSelfieId} is not null and ${t.checkInLat} is not null and ${t.checkInLng} is not null)`),
    check('attendance_sessions_on_behalf_reason', sql`(${t.openedOnBehalfBy} is null) = (${t.onBehalfReason} is null)`),
    check('attendance_sessions_closed', sql`(${t.status} = 'CLOSED') = (${t.checkedOutAt} is not null)`),
    check('attendance_sessions_check_out_evidence', sql`${t.checkedOutAt} is null or (
      ${t.checkOutSelfieId} is not null and ${t.checkOutLat} is not null and ${t.checkOutLng} is not null)`),
  ],
);

/** ATT-003: breaks, where the Admin has enabled them; excluded from active hours. */
export const attendanceBreaks = pgTable(
  'attendance_breaks',
  {
    id: id(),
    sessionId: uuid('session_id').notNull().references(() => attendanceSessions.id),
    startedAt: timestamptz('started_at').notNull(),
    endedAt: timestamptz('ended_at'),
  },
  (t) => [
    uniqueIndex('attendance_breaks_one_open').on(t.sessionId).where(sql`${t.endedAt} is null`),
    index('attendance_breaks_session_id_idx').on(t.sessionId),
    check('attendance_breaks_period', sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`),
  ],
);

/**
 * VEH-004: readings run continuously against the vehicle, whoever drives it.
 * Append-only; the vehicle's current reading is the latest row.
 */
export const odometerReadings = pgTable(
  'odometer_readings',
  {
    id: id(),
    vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id),
    readingKm: integer('reading_km').notNull(),
    source: odometerSource('source').notNull(),
    sessionId: uuid('session_id').references(() => attendanceSessions.id),
    photoId: uuid('photo_id').references(() => mediaAssets.id),
    note: text('note'),
    recordedAt: timestamptz('recorded_at').notNull(),
    recordedBy: uuid('recorded_by').notNull().references(() => users.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('odometer_readings_vehicle_idx').on(t.vehicleId, t.recordedAt),
    index('odometer_readings_session_id_idx').on(t.sessionId),
    check('odometer_readings_non_negative', sql`${t.readingKm} >= 0`),
    check('odometer_readings_correction_note', sql`${t.source} <> 'CORRECTION' or ${t.note} is not null`),
  ],
);
