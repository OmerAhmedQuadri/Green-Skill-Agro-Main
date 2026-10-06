import { describe, expect, it } from 'vitest';
import { type DomainError } from '../errors';
import { parseSetting, resolveSettings, SETTINGS } from '../system';
import { businessDate } from '../time';
import {
  addMonths, isPastRetention, nextRetentionRun, RETENTION_SETTING, retentionDueOn, retentionOf, retentionScanBefore, STORED_KINDS,
} from './retention';

const riyadh = (local: string) => new Date(`${local}+03:00`);
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as DomainError).code; } return 'NO_ERROR'; };

describe('storage retention (ADR-0049)', () => {
  it('SYS-010: the approved defaults — selfies and odometer photos 3 months, write-offs and transport slips 6, the rest forever', () => {
    const defaults = resolveSettings([]);
    expect(Object.fromEntries(STORED_KINDS.map((k) => [k, retentionOf(defaults, k)]))).toEqual({
      SELFIE: 3, ODOMETER: 3, STOREFRONT: 'FOREVER', WRITE_OFF_EVIDENCE: 6, DEPOSIT_SLIP: 'FOREVER',
      TRANSPORT_SLIP: 6, PAYMENT_VOUCHER: 'FOREVER', DELIVERY_DOCUMENT: 'FOREVER',
    });
    expect(defaults['storage.budget_gb']).toBe(10);
  });

  it('SYS-010: a period is whole months from 1 to 120, or forever; selfies never forever and at most 24 months', () => {
    expect(parseSetting('storage.keep_odometer', 'FOREVER')).toBe('FOREVER');
    expect(parseSetting('storage.keep_odometer', 120)).toBe(120);
    for (const bad of [0, 121, 1.5, '3', null]) expect(code(() => parseSetting('storage.keep_odometer', bad))).toBe('INVALID_SETTING');
    expect(code(() => parseSetting('storage.keep_selfie', 'FOREVER'))).toBe('INVALID_SETTING');
    expect(code(() => parseSetting('storage.keep_selfie', 25))).toBe('INVALID_SETTING');
    expect(parseSetting('storage.keep_selfie', 24)).toBe(24);
  });

  it('SYS-010: only the Super Admin\'s storage permission governs the periods', () => {
    for (const key of Object.values(RETENTION_SETTING)) expect(SETTINGS[key].permission).toBe('system.manage_storage');
    expect(SETTINGS['storage.budget_gb'].permission).toBe('system.manage_storage');
  });

  it('months are added as Postgres adds them, the day clamped to the month\'s end', () => {
    expect(addMonths('2026-01-15', 3)).toBe('2026-04-15');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonths('2026-03-01', -3)).toBe('2025-12-01');
    expect(addMonths('2026-06-30', 120)).toBe('2036-06-30');
  });

  it('SYS-010: a file falls due on the day it was stored plus its period, in Riyadh time', () => {
    // 15 January late at night in UTC is already 16 January in Riyadh.
    expect(retentionDueOn(riyadh('2026-01-15T10:00:00'), 3)).toBe('2026-04-15');
    expect(retentionDueOn(new Date('2026-01-15T22:00:00Z'), 3)).toBe('2026-04-16');
    expect(retentionDueOn(riyadh('2026-01-31T09:00:00'), 1)).toBe('2026-02-28');
    expect(retentionDueOn(riyadh('2026-01-15T10:00:00'), 'FOREVER')).toBeNull();
    expect(isPastRetention(riyadh('2026-01-15T10:00:00'), 3, '2026-04-14')).toBe(false);
    expect(isPastRetention(riyadh('2026-01-15T10:00:00'), 3, '2026-04-15')).toBe(true);
    expect(isPastRetention(riyadh('2026-01-15T10:00:00'), 'FOREVER', '2099-12-31')).toBe(false);
  });

  it('the scan bound never leaves out a file that is due', () => {
    // Every day of two years, for a spread of periods: whatever is due on `today` was stored before the bound.
    for (const months of [1, 3, 6, 18, 120]) {
      for (let day = 0; day < 731; day += 1) {
        const stored = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000 + 9 * 3_600_000);
        const due = retentionDueOn(stored, months) ?? '';
        expect(stored.getTime()).toBeLessThan(retentionScanBefore(months, due).getTime());
      }
    }
    expect(retentionScanBefore(3, '2026-04-15').toISOString()).toBe(riyadh('2026-02-01T00:00:00').toISOString());
  });

  it('the next run is 04:00 Riyadh — today until it starts, then tomorrow', () => {
    expect(nextRetentionRun(riyadh('2026-10-06T01:30:00')).toISOString()).toBe(riyadh('2026-10-06T04:00:00').toISOString());
    expect(nextRetentionRun(riyadh('2026-10-06T04:00:00')).toISOString()).toBe(riyadh('2026-10-07T04:00:00').toISOString());
    expect(businessDate(nextRetentionRun(riyadh('2026-12-31T23:00:00')))).toBe('2027-01-01');
  });
});
