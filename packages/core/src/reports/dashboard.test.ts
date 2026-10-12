import { describe, expect, it } from 'vitest';
import type { Money } from '../numeric';
import { glanceDays, overdueOf, percentChange, teamStatus, worstBand } from './dashboard';

const m = (v: string) => v as Money;
const aged = (NOT_DUE: string, DAYS_1_30: string, DAYS_31_60: string, DAYS_61_90: string, OVER_90: string, total: string) =>
  ({ NOT_DUE: m(NOT_DUE), DAYS_1_30: m(DAYS_1_30), DAYS_31_60: m(DAYS_31_60), DAYS_61_90: m(DAYS_61_90), OVER_90: m(OVER_90), total: m(total) });

describe('the dashboard (ADR-0054)', () => {
  it('RPT-012: thirty days of chart; this month so far against the same days of last month', () => {
    expect(glanceDays('2026-10-12')).toEqual({
      chart: { from: '2026-09-13', to: '2026-10-12' }, month: { from: '2026-10-01', to: '2026-10-12' }, lastMonth: { from: '2026-09-01', to: '2026-09-12' },
    });
    // The 31st against a month of thirty: all of it, not a day into the next.
    expect(glanceDays('2026-10-31').lastMonth).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    // March against February, and January against last December.
    expect(glanceDays('2028-03-30').lastMonth).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(glanceDays('2027-01-05')).toMatchObject({ month: { from: '2027-01-01', to: '2027-01-05' }, lastMonth: { from: '2026-12-01', to: '2026-12-05' } });
  });

  it('RPT-012: the change against last month, to one place — none when last month had nothing', () => {
    expect(percentChange(m('1120.00'), m('1000.00'))).toBe('12.0');
    expect(percentChange(m('750.00'), m('1000.00'))).toBe('-25.0');
    expect(percentChange(m('1000.00'), m('3000.00'))).toBe('-66.7');
    expect(percentChange(m('500.00'), m('0.00'))).toBeNull();
  });

  it('RPT-014: overdue is everything not yet due excluded; the worst band a debt reached', () => {
    const a = aged('100.00', '0.00', '250.00', '0.00', '0.00', '350.00');
    expect(overdueOf(a)).toBe('250.00');
    expect(worstBand(a)).toBe('DAYS_31_60');
    expect(worstBand(aged('80.00', '0.00', '0.00', '0.00', '0.00', '80.00'))).toBe('NOT_DUE');
    expect(worstBand(aged('0.00', '0.00', '0.00', '0.00', '0.00', '0.00'))).toBeNull();
  });

  it('RPT-013: a seller\'s day — working, on a break, waiting for a manager, done, or not in', () => {
    expect(teamStatus('OPEN', false)).toBe('WORKING');
    expect(teamStatus('ON_BREAK', false)).toBe('ON_BREAK');
    expect(teamStatus('CHECKED_OUT', false)).toBe('DONE');
    expect(teamStatus('CLOSED', false)).toBe('DONE');
    expect(teamStatus(null, false)).toBe('NOT_IN');
    expect(teamStatus('OPEN', true)).toBe('AWAITING');
  });
});
