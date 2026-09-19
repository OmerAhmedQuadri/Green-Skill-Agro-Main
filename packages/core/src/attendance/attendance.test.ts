import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors';
import { compareClosing } from '../inventory/closing';
import {
  activeMs, assertWorking, attributeByDay, checkInOdometerFlags, checkOutOdometerFlags, distanceMetres, sessionDistanceKm,
  transitionDay, zoneCheck,
} from './attendance';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };
const at = (iso: string) => new Date(`${iso}+03:00`); // Riyadh wall-clock time
const H = 3_600_000;

describe('attendance day (STATE-MACHINES §10)', () => {
  it('ATT-004, ATT-005: check in, out, and in again the same day — a split shift', () => {
    expect(transitionDay(null, 'check_in')).toBe('OPEN');
    expect(transitionDay('OPEN', 'check_out')).toBe('CHECKED_OUT');
    expect(transitionDay('CHECKED_OUT', 'check_in')).toBe('OPEN');
    expect(code(() => transitionDay('OPEN', 'check_in'))).toBe('ALREADY_CHECKED_IN');
    expect(code(() => transitionDay(null, 'check_out'))).toBe('NOT_CHECKED_IN');
    expect(code(() => transitionDay('CLOSED', 'check_in'))).toBe('INVALID_TRANSITION');
  });

  it('ATT-003: a break starts and ends only while checked in; checking out ends it', () => {
    expect(transitionDay('OPEN', 'start_break')).toBe('ON_BREAK');
    expect(transitionDay('ON_BREAK', 'end_break')).toBe('OPEN');
    expect(transitionDay('ON_BREAK', 'check_out')).toBe('CHECKED_OUT');
    expect(code(() => transitionDay('CHECKED_OUT', 'start_break'))).toBe('NOT_CHECKED_IN');
  });

  it('ATT-010: stock work needs an OPEN day — not a break, not a waiting check-in, not after check-out', () => {
    expect(code(() => assertWorking({ status: 'OPEN', awaitingAuthorisation: false }))).toBe('NO_ERROR');
    expect(code(() => assertWorking(null))).toBe('CHECK_IN_REQUIRED');
    expect(code(() => assertWorking({ status: 'CHECKED_OUT', awaitingAuthorisation: false }))).toBe('CHECK_IN_REQUIRED');
    expect(code(() => assertWorking({ status: 'ON_BREAK', awaitingAuthorisation: false }))).toBe('ON_BREAK');
    expect(code(() => assertWorking({ status: 'CHECKED_OUT', awaitingAuthorisation: true }))).toBe('ZONE_AUTHORISATION_PENDING');
  });
});

describe('zones (ATT-008)', () => {
  const warehouse = { id: 'wh', lat: 24.7136, lng: 46.6753, radiusM: 200 };

  it('ATT-008: distance is great-circle metres', () => {
    expect(Math.round(distanceMetres({ lat: 24.7136, lng: 46.6753 }, { lat: 24.7236, lng: 46.6753 }))).toBe(1112);
  });

  it('ATT-008: with restriction on, a check-in inside a zone passes and one outside waits', () => {
    expect(zoneCheck({ lat: 24.7140, lng: 46.6755 }, 10, [warehouse], true)).toEqual({ inside: true, zoneId: 'wh' });
    expect(zoneCheck({ lat: 24.7236, lng: 46.6753 }, 10, [warehouse], true)).toEqual({ inside: false, zoneId: null });
  });

  it('ATT-008: GPS accuracy counts for the seller, up to 100 m; off or no zones restricts nothing', () => {
    const edge = { lat: 24.7136 + 250 / 111_195, lng: 46.6753 }; // 250 m north
    expect(zoneCheck(edge, 80, [warehouse], true).inside).toBe(true);
    expect(zoneCheck(edge, 20, [warehouse], true).inside).toBe(false);
    expect(zoneCheck({ lat: 24.7136 + 400 / 111_195, lng: 46.6753 }, 5000, [warehouse], true).inside).toBe(false);
    expect(zoneCheck({ lat: 0, lng: 0 }, null, [warehouse], false).inside).toBe(true);
    expect(zoneCheck({ lat: 0, lng: 0 }, null, [], true).inside).toBe(true);
  });
});

describe('odometer (ATT-012, VEH-004)', () => {
  it('ATT-012: a check-in below the vehicle\'s last reading, or far beyond it, is flagged — never refused', () => {
    expect(checkInOdometerFlags(null, 5000, 5)).toEqual([]);
    expect(checkInOdometerFlags(5000, 5003, 5)).toEqual([]);
    expect(checkInOdometerFlags(5000, 4990, 5)).toEqual(['BELOW_PREVIOUS']);
    expect(checkInOdometerFlags(5000, 5100, 5)).toEqual(['GAP_FROM_PREVIOUS']);
  });

  it('ATT-012: a check-out below its check-in, or an implausible distance, is flagged', () => {
    expect(checkOutOdometerFlags(5000, 5180, 500)).toEqual([]);
    expect(checkOutOdometerFlags(5000, 4999, 500)).toEqual(['BELOW_CHECK_IN']);
    expect(checkOutOdometerFlags(5000, 5600, 500)).toEqual(['DISTANCE_IMPLAUSIBLE']);
    expect(checkOutOdometerFlags(null, 5600, 500)).toEqual([]);
  });

  it('ATT-002, ATT-007: distance is check-out less check-in; no vehicle, no distance', () => {
    expect(sessionDistanceKm(5000, 5180)).toBe(180);
    expect(sessionDistanceKm(5000, 4990)).toBe(0);
    expect(sessionDistanceKm(null, null)).toBeNull();
  });
});

describe('hours (ATT-002, ATT-006)', () => {
  it('ATT-002, ATT-003: active hours are the session less its breaks', () => {
    const s = { from: at('2026-10-05T07:00:00'), to: at('2026-10-05T16:00:00'), distanceKm: 120,
      breaks: [{ from: at('2026-10-05T12:00:00'), to: at('2026-10-05T13:00:00') }] };
    expect(activeMs(s, at('2026-10-05T20:00:00'))).toBe(8 * H);
    expect(attributeByDay(s, at('2026-10-05T20:00:00'))).toEqual([{ date: '2026-10-05', activeMs: 8 * H, distanceKm: 120 }]);
  });

  it('ATT-002: an open session counts to now, and an open break is not worked', () => {
    const s = { from: at('2026-10-05T07:00:00'), to: null, distanceKm: null, breaks: [{ from: at('2026-10-05T10:00:00'), to: null }] };
    expect(activeMs(s, at('2026-10-05T11:00:00'))).toBe(3 * H);
  });

  it('ATT-006, OQ-004: a trip across midnight splits hours by clock time, distance pro-rata', () => {
    const s = { from: at('2026-10-05T18:00:00'), to: at('2026-10-06T06:00:00'), distanceKm: 900, breaks: [] };
    expect(attributeByDay(s, at('2026-10-07T00:00:00'))).toEqual([
      { date: '2026-10-05', activeMs: 6 * H, distanceKm: 450 },
      { date: '2026-10-06', activeMs: 6 * H, distanceKm: 450 },
    ]);
    const three = { from: at('2026-10-05T06:00:00'), to: at('2026-10-07T20:00:00'), distanceKm: 1000, breaks: [] };
    const shares = attributeByDay(three, at('2026-10-08T00:00:00'));
    expect(shares.map((d) => [d.date, d.activeMs / H])).toEqual([['2026-10-05', 18], ['2026-10-06', 24], ['2026-10-07', 20]]);
    expect(shares.reduce((sum, d) => sum + (d.distanceKm ?? 0), 0)).toBeCloseTo(1000, 6);
  });
});

describe('closing stock (STK-010, 011)', () => {
  it('STK-011: equal on every SKU matches; any difference — either way, or an SKU missed — is flagged', () => {
    expect(compareClosing([{ skuId: 'a', packs: 10 }], [{ skuId: 'a', packs: 10 }]).status).toBe('MATCHED');
    const flagged = compareClosing([{ skuId: 'a', packs: 8 }, { skuId: 'c', packs: 1 }], [{ skuId: 'a', packs: 10 }, { skuId: 'b', packs: 3 }]);
    expect(flagged.status).toBe('VARIANCE_FLAGGED');
    expect(flagged.lines).toEqual([
      { skuId: 'a', declaredPacks: 8, systemPacks: 10, variancePacks: -2 },
      { skuId: 'b', declaredPacks: 0, systemPacks: 3, variancePacks: -3 },
      { skuId: 'c', declaredPacks: 1, systemPacks: 0, variancePacks: 1 },
    ]);
  });
});
