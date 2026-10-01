import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors';
import type { Money } from '../numeric';
import { ageDebts, ageingBand, analyticsRange, rangePeriods } from './analytics';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };
const m = (v: string) => v as Money;

describe('the range a sales view covers (ADR-0048)', () => {
  it('ADR-0048: whole Riyadh days, both ends included — from midnight before the first to midnight after the last', () => {
    const range = analyticsRange('2026-09-01', '2026-09-30');
    expect(range).toMatchObject({ days: 30, bucket: 'DAY' });
    expect(range.start.toISOString()).toBe('2026-08-31T21:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(analyticsRange('2026-09-30', '2026-09-30').days).toBe(1);
  });

  it('ADR-0048: by day up to 62 days, by month beyond', () => {
    expect(analyticsRange('2026-08-01', '2026-10-01').bucket).toBe('DAY'); // 62 days
    expect(analyticsRange('2026-07-31', '2026-10-01').bucket).toBe('MONTH'); // 63
  });

  it('ADR-0048: a year at most, the right way round, and dates that exist', () => {
    expect(analyticsRange('2025-10-01', '2026-10-01').days).toBe(366);
    expect(code(() => analyticsRange('2025-09-30', '2026-10-01'))).toBe('RANGE_TOO_LONG');
    expect(code(() => analyticsRange('2026-10-02', '2026-10-01'))).toBe('INVALID_DATE');
    expect(code(() => analyticsRange('2026-02-30', '2026-03-01'))).toBe('INVALID_DATE');
    expect(code(() => analyticsRange('2026-9-1', '2026-10-01'))).toBe('INVALID_DATE');
  });

  it('ADR-0048: every period is there, so a day or month with no sales still shows, at nothing', () => {
    expect(rangePeriods(analyticsRange('2026-02-27', '2026-03-02'))).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(rangePeriods(analyticsRange('2025-11-15', '2026-02-10'))).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('ageing what stores owe (RPT-008)', () => {
  it('RPT-008: days past the due date, in bands — due today is not late', () => {
    expect(ageingBand('2026-10-01', '2026-10-01')).toBe('NOT_DUE');
    expect(ageingBand('2026-10-15', '2026-10-01')).toBe('NOT_DUE');
    expect(ageingBand('2026-09-30', '2026-10-01')).toBe('DAYS_1_30');
    expect(ageingBand('2026-09-01', '2026-10-01')).toBe('DAYS_1_30'); // 30 days
    expect(ageingBand('2026-08-31', '2026-10-01')).toBe('DAYS_31_60');
    expect(ageingBand('2026-07-03', '2026-10-01')).toBe('DAYS_61_90'); // 90 days
    expect(ageingBand('2026-07-02', '2026-10-01')).toBe('OVER_90');
  });

  it('RPT-008: a store\'s debts add up by band, and to the total', () => {
    const aged = ageDebts([
      { dueOn: '2026-10-05', open: m('100.00') },
      { dueOn: '2026-09-20', open: m('40.50') },
      { dueOn: '2026-09-25', open: m('9.50') },
      { dueOn: '2026-05-01', open: m('300.00') },
    ], '2026-10-01');
    expect(aged).toEqual({ NOT_DUE: '100.00', DAYS_1_30: '50.00', DAYS_31_60: '0.00', DAYS_61_90: '0.00', OVER_90: '300.00', total: '450.00' });
  });
});
