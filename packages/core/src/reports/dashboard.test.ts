import { describe, expect, it } from 'vitest';
import { effectivePermissions, presetOverrides, PRESET_DEFAULTS } from '../identity';
import type { Money } from '../numeric';
import { comparisonRange, dashboardTabs, overdueOf, percentChange, teamStatus, worstBand } from './dashboard';

const m = (v: string) => v as Money;
const aged = (NOT_DUE: string, DAYS_1_30: string, DAYS_31_60: string, DAYS_61_90: string, OVER_90: string, total: string) =>
  ({ NOT_DUE: m(NOT_DUE), DAYS_1_30: m(DAYS_1_30), DAYS_31_60: m(DAYS_31_60), DAYS_61_90: m(DAYS_61_90), OVER_90: m(OVER_90), total: m(total) });

describe('the dashboard (ADR-0054)', () => {
  it('RPT-012: a month so far against the same days of last month; any other period against as many days before it', () => {
    expect(comparisonRange('2026-10-01', '2026-10-12')).toEqual({ from: '2026-09-01', to: '2026-09-12' });
    // The 31st against a month of thirty: all of it, not a day into the next.
    expect(comparisonRange('2026-10-01', '2026-10-31')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(comparisonRange('2028-03-01', '2028-03-30')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(comparisonRange('2027-01-01', '2027-01-05')).toEqual({ from: '2026-12-01', to: '2026-12-05' });
    // A day against the day before; seven days against the seven before; a span of months against as long before it.
    expect(comparisonRange('2026-10-12', '2026-10-12')).toEqual({ from: '2026-10-11', to: '2026-10-11' });
    expect(comparisonRange('2026-10-06', '2026-10-12')).toEqual({ from: '2026-09-29', to: '2026-10-05' });
    expect(comparisonRange('2026-08-15', '2026-10-12')).toEqual({ from: '2026-06-17', to: '2026-08-14' }); // 59 days each
  });

  it('RPT-012: the change, to one place — none when there was nothing before', () => {
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

  it('ADR-0054: each tab for whoever may see some of it — the Admin all five, the warehouse stock, a seller none', () => {
    expect(dashboardTabs(effectivePermissions('ADMIN', new Map()))).toEqual(['sales', 'team', 'stores', 'money', 'stock']);
    expect(dashboardTabs(effectivePermissions('MANAGER', presetOverrides(PRESET_DEFAULTS.WAREHOUSE)))).toEqual(['stock']);
    expect(dashboardTabs(effectivePermissions('MANAGER', presetOverrides(PRESET_DEFAULTS.SALES_MANAGER)))).toEqual(['sales', 'team', 'stores', 'money', 'stock']);
    expect(dashboardTabs(effectivePermissions('SELLER', new Map()))).toEqual([]);
  });
});
