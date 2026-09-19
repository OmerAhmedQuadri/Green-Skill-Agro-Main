import type { DomainError, UserId } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { aLoadedVehicle, aSeller, AWAY, aVehicle, captureFor, checkInAs, YARD } from '../../test/vehicles';
import { submitWriteOff } from '../inventory';
import { listMyNotifications } from '../notifications';
import { updateToggles } from '../system';
import { assignVehicle, getVehicle } from '../vehicles';
import {
  authoriseZone, checkIn, checkOut, closeFinishedDays, createZone, getToday, listAttendance, openDayOnBehalf, reviewSession, setBreak,
} from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async () => ctxFor(await anAccount('ADMIN'));
const H = 3_600_000;
/** Riyadh wall-clock time on a fixed day, far from today, so each test controls the clock. */
const t = (hhmm: string, day = '2026-10-05') => new Date(`${day}T${hhmm}:00+03:00`);

async function sellerWithVehicle(odometer = 10_000) {
  const ctx = await admin();
  const vehicle = await aVehicle(ctx, odometer);
  const seller = await aSeller();
  await assignVehicle(ctx, vehicle.id, { sellerId: seller.account.id });
  const as = (now: Date) => ctxFor(seller.account, { now });
  return { admin: ctx, vehicle, seller, as };
}

describe('check-in and check-out (workflow G, ATT-001..007)', () => {
  it('ATT-001: check-in captures a selfie, the location, an odometer photo and the reading', async () => {
    const { seller, vehicle } = await sellerWithVehicle();
    const today = await checkInAs(seller.ctx, { odometer: 10_004 });
    expect(today.day).toMatchObject({ status: 'OPEN', vehicle: { id: vehicle.id } });
    expect(today.live).toMatchObject({ status: 'OPEN', checkInOdometer: 10_004, flags: [] });
    const [row] = await ownerQuery<{ selfie: string | null; odo: string | null; lat: string }>(
      `select check_in_selfie_id as selfie, check_in_odo_photo_id as odo, check_in_lat as lat from attendance_sessions`);
    expect(row?.selfie && row.odo && row.lat).toBeTruthy();
  });

  it('ATT-001: with a vehicle the odometer is required; the location always; the selfie must be the seller\'s own', async () => {
    const { seller } = await sellerWithVehicle();
    const selfieId = await aPhoto(seller.ctx, 'SELFIE');
    expect(await code(checkIn(seller.ctx, { location: YARD, selfieId }))).toBe('ODOMETER_REQUIRED');
    expect(await code(checkIn(seller.ctx, { location: { lat: Number.NaN, lng: 46 }, selfieId }))).toBe('LOCATION_REQUIRED');
    const other = await aSeller();
    const theirs = await aPhoto(other.ctx, 'SELFIE');
    expect(await code(checkIn(seller.ctx, { location: YARD, selfieId: theirs, withoutVehicle: true }))).toBe('EVIDENCE_REQUIRED');
  });

  it('ATT-002, ATT-004: check-out computes distance from the odometer and active hours', async () => {
    const { as } = await sellerWithVehicle();
    await checkInAs(await as(t('07:00')), { odometer: 10_000 });
    const out = await checkOut(await as(t('16:30')), await captureFor(await as(t('16:30')), 10_184));
    expect(out.day?.status).toBe('CHECKED_OUT');
    expect(out.totals).toEqual({ activeMs: 9.5 * H, distanceKm: 184 });
    expect(await code(checkOut(await as(t('16:31')), await captureFor(await as(t('16:31')), 10_184)))).toBe('NOT_CHECKED_IN');
  });

  it('ATT-005: a second check-in the same day is a split shift, aggregated into one day', async () => {
    const { as } = await sellerWithVehicle();
    await checkInAs(await as(t('06:00')), { odometer: 10_000 });
    expect(await code(checkInAs(await as(t('07:00')), { odometer: 10_000 }))).toBe('ALREADY_CHECKED_IN');
    await checkOut(await as(t('10:00')), await captureFor(await as(t('10:00')), 10_060));
    await checkInAs(await as(t('15:00')), { odometer: 10_060 });
    const day = await checkOut(await as(t('19:00')), await captureFor(await as(t('19:00')), 10_100));
    expect(day.sessions).toHaveLength(2);
    expect(day.totals).toEqual({ activeMs: 8 * H, distanceKm: 100 });
  });

  it('ATT-003: breaks exist only when enabled, and are excluded from active hours', async () => {
    const { admin: ctx, as } = await sellerWithVehicle();
    await checkInAs(await as(t('08:00')));
    await updateToggles(ctx, [{ key: 'attendance.break_logging', enabled: false }]);
    expect(await code(setBreak(await as(t('12:00')), 'start'))).toBe('FEATURE_DISABLED');
    await updateToggles(ctx, [{ key: 'attendance.break_logging', enabled: true }]);
    expect((await setBreak(await as(t('12:00')), 'start')).day?.status).toBe('ON_BREAK');
    expect((await setBreak(await as(t('12:45')), 'end')).day?.status).toBe('OPEN');
    await setBreak(await as(t('15:00')), 'start');
    const out = await checkOut(await as(t('15:30')), await captureFor(await as(t('15:30')), 10_050)); // ends the open break
    expect(out.totals.activeMs).toBe(6.25 * H); // 08:00–15:30, less 12:00–12:45 and 15:00–15:30
    expect(out.sessions[0]?.breaks).toHaveLength(2);
  });

  it('ATT-006, OQ-004: a trip past midnight stays with its first day; hours and distance split by clock time', async () => {
    const { admin: ctx, as, seller } = await sellerWithVehicle();
    await checkInAs(await as(t('18:00')), { odometer: 10_000 });
    await closeFinishedDays(t('03:00', '2026-10-06')); // an open trip is not closed
    const out = await checkOut(await as(t('06:00', '2026-10-06')), await captureFor(await as(t('06:00', '2026-10-06')), 10_900));
    expect(out.day).toMatchObject({ workDate: '2026-10-05', status: 'CHECKED_OUT' });
    const [row] = await listAttendance(await ctxFor({ id: ctx.user.id, role: 'ADMIN' }, { now: t('07:00', '2026-10-06') }), { from: '2026-10-05', to: '2026-10-06', sellerId: seller.account.id });
    expect(row?.attribution).toEqual([
      { date: '2026-10-05', activeMs: 6 * H, distanceKm: 450 },
      { date: '2026-10-06', activeMs: 6 * H, distanceKm: 450 },
    ]);
  });

  it('ATT-007: a day without the vehicle skips the odometer, records no distance, and has no vehicle stock', async () => {
    const ctx = await admin();
    const { seller, bagBatch } = await aLoadedVehicle(ctx, 5);
    await checkOut(seller.ctx, await captureFor(seller.ctx, 10_010));
    const tomorrow = await ctxFor(seller.account, { now: new Date(Date.now() + 86_400_000) });
    const today = await checkInAs(tomorrow, { withoutVehicle: true });
    expect(today.day?.vehicle).toBeNull();
    expect(today.live).toMatchObject({ checkInOdometer: null });
    const photoId = await aPhoto(tomorrow, 'WRITE_OFF_EVIDENCE');
    expect(await code(submitWriteOff(tomorrow, { batchId: bagBatch.batchId, packs: 1, reason: 'DAMAGED', photoId }))).toBe('NO_VEHICLE_TODAY');
    const out = await checkOut(tomorrow, { location: YARD, selfieId: await aPhoto(tomorrow, 'SELFIE') });
    expect(out.totals.distanceKm).toBeNull();
  });
});

describe('guard, zones and manager actions (ATT-008..013)', () => {
  it('ATT-010: without an open check-in a seller records no stock movement; on a break neither', async () => {
    const ctx = await admin();
    const { seller, bagBatch } = await aLoadedVehicle(ctx, 5);
    const photoId = await aPhoto(seller.ctx, 'WRITE_OFF_EVIDENCE');
    await setBreak(seller.ctx, 'start');
    expect(await code(submitWriteOff(seller.ctx, { batchId: bagBatch.batchId, packs: 1, reason: 'DAMAGED', photoId }))).toBe('ON_BREAK');
    await setBreak(seller.ctx, 'end');
    await checkOut(seller.ctx, await captureFor(seller.ctx, 10_020));
    expect(await code(submitWriteOff(seller.ctx, { batchId: bagBatch.batchId, packs: 1, reason: 'DAMAGED', photoId }))).toBe('CHECK_IN_REQUIRED');
  });

  it('ATT-008, ATT-009: outside every zone the check-in waits for a manager; authorised, the day opens', async () => {
    const { admin: ctx, seller } = await sellerWithVehicle();
    await createZone(ctx, { name: 'Warehouse yard', lat: YARD.lat, lng: YARD.lng, radiusM: 300 });
    await updateToggles(ctx, [{ key: 'attendance.restricted_check_in', enabled: true }]);
    const waiting = await checkInAs(seller.ctx, { location: AWAY });
    expect(waiting.live).toMatchObject({ status: 'AWAITING_AUTHORISATION', activeMs: 0 });
    const photoId = await aPhoto(seller.ctx, 'WRITE_OFF_EVIDENCE');
    expect(await code(submitWriteOff(seller.ctx, { batchId: '00000000-0000-7000-8000-000000000000', packs: 1, reason: 'DAMAGED', photoId }))).toBe('ZONE_AUTHORISATION_PENDING');
    expect((await listMyNotifications(ctx)).items.map((n) => n.kind)).toContain('CHECK_IN_AWAITING_AUTHORISATION');
    await authoriseZone(ctx, waiting.live?.id ?? '');
    expect((await getToday(seller.ctx)).live?.status).toBe('OPEN');
    expect(await code(authoriseZone(ctx, waiting.live?.id ?? ''))).toBe('ALREADY_DECIDED');
    expect((await listMyNotifications(seller.ctx)).items.map((n) => n.kind)).toContain('CHECK_IN_AUTHORISED');
  });

  it('ATT-008: inside a zone passes at once; a new attempt withdraws a waiting one', async () => {
    const { admin: ctx, seller } = await sellerWithVehicle();
    await createZone(ctx, { name: 'Warehouse yard', lat: YARD.lat, lng: YARD.lng, radiusM: 300 });
    await updateToggles(ctx, [{ key: 'attendance.restricted_check_in', enabled: true }]);
    await checkInAs(seller.ctx, { location: AWAY });
    const inside = await checkInAs(await ctxFor(seller.account), { location: YARD, odometer: 10_000 });
    expect(inside.live?.status).toBe('OPEN');
    expect(inside.sessions).toHaveLength(1);
    const [row] = await ownerQuery<{ n: number }>(`select count(*)::int as n from attendance_sessions where status = 'WITHDRAWN'`);
    expect(row?.n).toBe(1);
  });

  it('ATT-011: a manager opens the day on a seller\'s behalf with a reason; the seller is told and can work', async () => {
    const { admin: ctx, seller } = await sellerWithVehicle();
    expect(await code(openDayOnBehalf(ctx, { sellerId: seller.account.id, reason: ' ' }))).toBe('REASON_REQUIRED');
    await openDayOnBehalf(ctx, { sellerId: seller.account.id, reason: 'Phone battery dead at the yard', odometer: 10_002 });
    const today = await getToday(seller.ctx);
    expect(today.live).toMatchObject({ status: 'OPEN', openedOnBehalf: true, onBehalfReason: 'Phone battery dead at the yard', checkInOdometer: 10_002 });
    expect((await listMyNotifications(seller.ctx)).items.map((n) => n.kind)).toContain('DAY_OPENED_ON_BEHALF');
    expect(await code(openDayOnBehalf(ctx, { sellerId: seller.account.id, reason: 'again' }))).toBe('ALREADY_CHECKED_IN');
    const out = await checkOut(seller.ctx, await captureFor(seller.ctx, 10_050));
    expect(out.totals.distanceKm).toBe(48);
  });

  it('ATT-012, VEH-004: a reading below the vehicle\'s last one, or an implausible distance, is flagged and accepted', async () => {
    const { admin: ctx, vehicle, as } = await sellerWithVehicle(10_000);
    const flagged = await checkInAs(await as(t('07:00')), { odometer: 9_990 });
    expect(flagged.live?.flags).toEqual(['BELOW_PREVIOUS']);
    const out = await checkOut(await as(t('18:00')), await captureFor(await as(t('18:00')), 10_700));
    expect(out.sessions[0]?.flags).toEqual(['BELOW_PREVIOUS', 'DISTANCE_IMPLAUSIBLE']);
    expect((await getVehicle(ctx, vehicle.id)).odometer).toBe(10_700);
    const [day] = await listAttendance(await ctxFor({ id: ctx.user.id, role: 'ADMIN' }, { now: t('19:00') }), { from: '2026-10-05', attention: true });
    expect(day?.needsAttention).toBe(true);
    expect(await code(reviewSession(ctx, out.sessions[0]?.id ?? '', { comment: '' }))).toBe('REASON_REQUIRED');
    await reviewSession(ctx, out.sessions[0]?.id ?? '', { comment: 'Long delivery run to Al-Kharj; reading confirmed from the photo' });
    expect(await listAttendance(await ctxFor({ id: ctx.user.id, role: 'ADMIN' }, { now: t('19:00') }), { from: '2026-10-05', attention: true })).toEqual([]);
  });

  it('VEH-004: readings run on across drivers — the next seller\'s check-in continues from the last one', async () => {
    const { admin: ctx, vehicle, as } = await sellerWithVehicle(10_000);
    await checkInAs(await as(t('07:00')), { odometer: 10_000 });
    await checkOut(await as(t('12:00')), await captureFor(await as(t('12:00')), 10_120));
    const next = await aSeller();
    await assignVehicle(ctx, vehicle.id, { sellerId: next.account.id });
    const cont = await checkInAs(await ctxFor(next.account, { now: t('13:00') }), { odometer: 10_121 });
    expect(cont.live?.flags).toEqual([]);
    const gap = await aSeller();
    await checkOut(await ctxFor(next.account, { now: t('14:00') }), await captureFor(await ctxFor(next.account, { now: t('14:00') }), 10_150));
    await assignVehicle(await admin(), vehicle.id, { sellerId: gap.account.id });
    expect((await checkInAs(await ctxFor(gap.account, { now: t('15:00') }), { odometer: 10_400 })).live?.flags).toEqual(['GAP_FROM_PREVIOUS']);
  });

  it('ATT-013: location is kept only at check-in, check-out and on photos — there is nowhere to track a route', async () => {
    const columns = await ownerQuery<{ c: string }>(`
      select table_name || '.' || column_name as c from information_schema.columns
      where table_schema = 'public' and column_name like '%lat' order by 1`);
    expect(columns.map((r) => r.c)).toEqual(['attendance_sessions.check_in_lat', 'attendance_sessions.check_out_lat', 'check_in_zones.lat', 'media_assets.captured_lat']);
  });

  it('ATT-011: only attendance managers open days, authorise and review; sellers see only their own day', async () => {
    const { seller } = await sellerWithVehicle();
    const plain = await ctxFor(await anAccount('MANAGER'));
    expect(await code(openDayOnBehalf(plain, { sellerId: seller.account.id, reason: 'x' }))).toBe('FORBIDDEN');
    expect(await code(listAttendance(seller.ctx))).toBe('FORBIDDEN');
    expect(await code(getToday(plain))).toBe('FORBIDDEN');
  });

  it('STATE-MACHINES §10: the 03:00 job closes earlier checked-out days and withdraws stale waiting check-ins', async () => {
    const { admin: ctx, as, seller } = await sellerWithVehicle();
    await checkInAs(await as(t('07:00')));
    await checkOut(await as(t('15:00')), await captureFor(await as(t('15:00')), 10_030));
    const waiter = await aSeller();
    await createZone(ctx, { name: 'Yard', lat: YARD.lat, lng: YARD.lng, radiusM: 300 });
    await updateToggles(ctx, [{ key: 'attendance.restricted_check_in', enabled: true }]);
    await checkInAs(await ctxFor(waiter.account, { now: t('08:00') }), { location: AWAY, withoutVehicle: true });
    expect(await closeFinishedDays(t('03:00', '2026-10-06'))).toEqual({ closed: 2, withdrawn: 1 });
    expect(await closeFinishedDays(t('03:00', '2026-10-06'))).toEqual({ closed: 0, withdrawn: 0 }); // idempotent
    const rows = await ownerQuery<{ seller_id: UserId; status: string }>(`select seller_id, status from attendance_days order by seller_id`);
    expect(rows.every((r) => r.status === 'CLOSED')).toBe(true);
    expect(rows.map((r) => r.seller_id).sort()).toEqual([seller.account.id, waiter.account.id].sort());
  });
});
