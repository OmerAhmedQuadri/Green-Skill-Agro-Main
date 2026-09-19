import { DomainError } from '../errors';
import { businessDate, businessDayStart, nextBusinessDate } from '../time';

// ---------------------------------------------------------------- states (STATE-MACHINES §10)

export const ATTENDANCE_DAY_STATUSES = ['OPEN', 'ON_BREAK', 'CHECKED_OUT', 'CLOSED'] as const;
export type AttendanceDayStatus = (typeof ATTENDANCE_DAY_STATUSES)[number];

/**
 * AWAITING_AUTHORISATION — checked in outside every zone; a manager decides (ATT-009)
 * OPEN / CLOSED — checked in / checked out
 * WITHDRAWN — a waiting check-in replaced by a new attempt
 */
export const ATTENDANCE_SESSION_STATUSES = ['AWAITING_AUTHORISATION', 'OPEN', 'CLOSED', 'WITHDRAWN'] as const;
export type AttendanceSessionStatus = (typeof ATTENDANCE_SESSION_STATUSES)[number];

export type DayAction = 'check_in' | 'start_break' | 'end_break' | 'check_out' | 'close';

const DAY_RULES: Record<DayAction, { from: readonly (AttendanceDayStatus | null)[]; to: AttendanceDayStatus; refused: 'ALREADY_CHECKED_IN' | 'NOT_CHECKED_IN' | 'INVALID_TRANSITION' }> = {
  // null: no day yet. CHECKED_OUT → OPEN is a split shift (ATT-005).
  check_in: { from: [null, 'CHECKED_OUT'], to: 'OPEN', refused: 'ALREADY_CHECKED_IN' },
  start_break: { from: ['OPEN'], to: 'ON_BREAK', refused: 'NOT_CHECKED_IN' },
  end_break: { from: ['ON_BREAK'], to: 'OPEN', refused: 'INVALID_TRANSITION' },
  // Checking out while on break ends the break at the same moment.
  check_out: { from: ['OPEN', 'ON_BREAK'], to: 'CHECKED_OUT', refused: 'NOT_CHECKED_IN' },
  close: { from: ['CHECKED_OUT'], to: 'CLOSED', refused: 'INVALID_TRANSITION' },
};

/** The only way an attendance day changes state. */
export function transitionDay(status: AttendanceDayStatus | null, action: DayAction): AttendanceDayStatus {
  const rule = DAY_RULES[action];
  if (!rule.from.includes(status)) throw new DomainError(status === 'CLOSED' ? 'INVALID_TRANSITION' : rule.refused, { status, action });
  return rule.to;
}

/**
 * ATT-010: a seller records sales and stock movements only while the day is
 * OPEN. On a break, waiting for zone authorisation, or checked out, they cannot.
 */
export function assertWorking(day: { status: AttendanceDayStatus; awaitingAuthorisation: boolean } | null): void {
  if (day?.awaitingAuthorisation) throw new DomainError('ZONE_AUTHORISATION_PENDING');
  if (!day || day.status === 'CHECKED_OUT' || day.status === 'CLOSED') throw new DomainError('CHECK_IN_REQUIRED');
  if (day.status === 'ON_BREAK') throw new DomainError('ON_BREAK');
}

// ---------------------------------------------------------------- location (ATT-008, ATT-009, ATT-013)

export type GeoPoint = { readonly lat: number; readonly lng: number };
export type Zone = GeoPoint & { readonly id: string; readonly radiusM: number };

/** Great-circle distance in metres (haversine). */
export function distanceMetres(a: GeoPoint, b: GeoPoint): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** GPS accuracy counts in the seller's favour, up to this much (ADR-0032). */
export const MAX_ACCURACY_ALLOWANCE_M = 100;

export function assertLocation(p: GeoPoint | null | undefined): GeoPoint {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
    throw new DomainError('LOCATION_REQUIRED');
  }
  return p;
}

/**
 * ATT-008: with restriction on and at least one zone, a check-in must fall
 * inside one. Otherwise it waits for a manager (ATT-009). Restriction with no
 * zones defined restricts nothing.
 */
export function zoneCheck(point: GeoPoint, accuracyM: number | null, zones: readonly Zone[], restricted: boolean): { inside: boolean; zoneId: string | null } {
  if (!restricted || zones.length === 0) return { inside: true, zoneId: null };
  const allowance = Math.min(Math.max(accuracyM ?? 0, 0), MAX_ACCURACY_ALLOWANCE_M);
  const hit = zones.find((z) => distanceMetres(point, z) <= z.radiusM + allowance);
  return { inside: hit !== undefined, zoneId: hit?.id ?? null };
}

// ---------------------------------------------------------------- odometer (ATT-012)

export const ODOMETER_FLAGS = ['BELOW_PREVIOUS', 'GAP_FROM_PREVIOUS', 'BELOW_CHECK_IN', 'DISTANCE_IMPLAUSIBLE'] as const;
export type OdometerFlag = (typeof ODOMETER_FLAGS)[number];

/** A check-in reading against the vehicle's last one (VEH-004). Flagged, never rejected. */
export function checkInOdometerFlags(previous: number | null, reading: number, toleranceKm: number): OdometerFlag[] {
  if (previous === null) return [];
  if (reading < previous) return ['BELOW_PREVIOUS'];
  return reading - previous > toleranceKm ? ['GAP_FROM_PREVIOUS'] : [];
}

/** A check-out reading against its session's check-in. */
export function checkOutOdometerFlags(checkIn: number | null, reading: number, maxKm: number): OdometerFlag[] {
  if (checkIn === null) return [];
  if (reading < checkIn) return ['BELOW_CHECK_IN'];
  return reading - checkIn > maxKm ? ['DISTANCE_IMPLAUSIBLE'] : [];
}

/** Distance for a session; a reading below its check-in counts as none (and is flagged). */
export function sessionDistanceKm(checkIn: number | null, checkOut: number | null): number | null {
  if (checkIn === null || checkOut === null) return null;
  return Math.max(checkOut - checkIn, 0);
}

// ---------------------------------------------------------------- hours (ATT-002, ATT-005, ATT-006)

export type Interval = { readonly from: Date; readonly to: Date | null };
export type SessionSpan = Interval & { readonly breaks: readonly Interval[]; readonly distanceKm: number | null };

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Active time within [from, to): the session's span there, less its breaks there. */
function activeWithin(s: SessionSpan, from: number, to: number, now: Date): number {
  const end = (s.to ?? now).getTime();
  const worked = overlap(s.from.getTime(), end, from, to);
  const onBreak = s.breaks.reduce((sum, b) => sum + overlap(Math.max(b.from.getTime(), s.from.getTime()), Math.min((b.to ?? now).getTime(), end), from, to), 0);
  return Math.max(0, worked - onBreak);
}

/** ATT-002: a session's active time, less breaks. An open session counts to `now`. */
export function activeMs(s: SessionSpan, now: Date): number {
  return activeWithin(s, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, now);
}

export type DayShare = { readonly date: string; readonly activeMs: number; readonly distanceKm: number | null };

/**
 * OQ-004 default (c): a session crossing midnight splits its hours by clock
 * time per business day, and its distance pro-rata to those hours. Kept here,
 * in one function, so a different rule is one change.
 */
export function attributeByDay(s: SessionSpan, now: Date): DayShare[] {
  const end = s.to ?? now;
  const total = activeMs(s, now);
  const shares: DayShare[] = [];
  for (let date = businessDate(s.from); ; date = nextBusinessDate(date)) {
    const from = businessDayStart(date).getTime();
    const to = businessDayStart(nextBusinessDate(date)).getTime();
    const ms = activeWithin(s, from, to, now);
    shares.push({ date, activeMs: ms, distanceKm: null });
    if (to >= end.getTime()) break;
  }
  const distance = s.distanceKm;
  if (distance === null) return shares;
  // Pro-rata to one decimal; the last day takes the rounding remainder.
  let given = 0;
  return shares.map((share, i) => {
    const km = i === shares.length - 1
      ? Math.round((distance - given) * 10) / 10
      : Math.round((total === 0 ? (i === 0 ? distance : 0) : (distance * share.activeMs) / total) * 10) / 10;
    given += km;
    return { ...share, distanceKm: km };
  });
}
