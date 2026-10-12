import type { AttendanceDayStatus } from '../attendance';
import { dec, toMoney, type Money } from '../numeric';
import { addDays } from '../time';
import { AGEING_BANDS, type AgeingBand, type Ageing } from './analytics';

/** RPT-012 (ADR-0054): the chart covers the last thirty days, today included. */
export const CHART_DAYS = 30;
/** RPT-012..015 (ADR-0054): how many each short list on the dashboard shows. */
export const DASHBOARD_LIST_LENGTH = 5;

type Days = { readonly from: string; readonly to: string };

/**
 * RPT-012 (ADR-0054): the Riyadh calendar days the dashboard's sales cover —
 * the chart's thirty, this month so far, and the same days of last month, as
 * many as it had, so the comparison is like for like.
 */
export function glanceDays(today: string): { readonly chart: Days; readonly month: Days; readonly lastMonth: Days } {
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = addDays(monthStart, -1);
  const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
  const day = Math.min(Number(today.slice(8)), Number(lastMonthEnd.slice(8)));
  return {
    chart: { from: addDays(today, -(CHART_DAYS - 1)), to: today },
    month: { from: monthStart, to: today },
    lastMonth: { from: lastMonthStart, to: `${lastMonthEnd.slice(0, 8)}${String(day).padStart(2, '0')}` },
  };
}

/** The change from one figure to the next, as a percentage to one place — null with nothing to compare with. */
export function percentChange(current: Money, previous: Money): string | null {
  const before = dec(previous);
  if (before.isZero()) return null;
  return dec(current).minus(before).div(before.abs()).times(100).toFixed(1);
}

/** RPT-014: what of a debt is past its due date — all of it but what is not due yet. */
export const overdueOf = (aged: Ageing): Money => toMoney(dec(aged.total).minus(dec(aged.NOT_DUE)));

/** RPT-014: the latest band a debt has reached, or null when nothing is owed. */
export function worstBand(aged: Ageing): AgeingBand | null {
  return [...AGEING_BANDS].reverse().find((band) => !dec(aged[band]).isZero()) ?? null;
}

/** RPT-013 (ADR-0054): a seller's day as the dashboard names it, in the order the team is listed. */
export const TEAM_STATUSES = ['WORKING', 'ON_BREAK', 'AWAITING', 'DONE', 'NOT_IN'] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];

/** From the seller's attendance day today, if any, and whether their check-in still waits for a manager (ATT-009). */
export function teamStatus(day: AttendanceDayStatus | null, awaitingAuthorisation: boolean): TeamStatus {
  if (awaitingAuthorisation) return 'AWAITING';
  switch (day) {
    case 'OPEN': return 'WORKING';
    case 'ON_BREAK': return 'ON_BREAK';
    case 'CHECKED_OUT': case 'CLOSED': return 'DONE';
    case null: return 'NOT_IN';
  }
}
