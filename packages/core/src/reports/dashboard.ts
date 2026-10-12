import type { AttendanceDayStatus } from '../attendance';
import type { PermissionCode } from '../identity';
import { daysBetween } from '../inventory';
import { dec, toMoney, type Money } from '../numeric';
import { addDays } from '../time';
import { AGEING_BANDS, type AgeingBand, type Ageing } from './analytics';

/** RPT-012..016 (ADR-0054): how many each short list on the dashboard shows. */
export const DASHBOARD_LIST_LENGTH = 8;

/** RPT-012..016 (ADR-0054): the dashboard's tabs, in the order they are offered. */
export const DASHBOARD_TABS = ['sales', 'team', 'stores', 'money', 'stock'] as const;
export type DashboardTab = (typeof DASHBOARD_TABS)[number];

const anyOf = (permissions: ReadonlySet<PermissionCode>, codes: readonly PermissionCode[]) => codes.some((c) => permissions.has(c));

/**
 * ADR-0054: each tab for whoever may see some of its figures — the use cases
 * behind each part check their own permission again, and a part the reader
 * may not see is left out of the tab.
 */
export function dashboardTabs(permissions: ReadonlySet<PermissionCode>): DashboardTab[] {
  const has = (code: PermissionCode) => permissions.has(code);
  const shown: Record<DashboardTab, boolean> = {
    sales: has('reports.view_trends'),
    team: anyOf(permissions, ['attendance.view', 'attendance.manage', 'reports.view_trends', 'cash.view_cash_in_hand', 'cash.approve_settlement'])
      || (has('targets.view_commission') && has('targets.manage')),
    stores: has('stores.view_all'),
    money: (has('reports.view_trends') && has('stores.view_all')) || anyOf(permissions, ['cash.view_cash_in_hand', 'cash.approve_settlement']),
    stock: anyOf(permissions, [
      'inventory.view_all_stock', 'inventory.manage_expiry', 'reports.view_forecast', 'procurement.view', 'procurement.manage_po', 'procurement.approve_po',
      'inventory.receive_goods', 'vehicles.manage', 'inventory.issue_to_vehicle', 'sales.fulfil_dispatch', 'sales.view_all',
    ]),
  };
  return DASHBOARD_TABS.filter((tab) => shown[tab]);
}

/**
 * RPT-012 (ADR-0054): what a period is compared with. A month so far — from
 * its first — against the same days of last month, as many as it had; any
 * other period against as many days just before it.
 */
export function comparisonRange(from: string, to: string): { readonly from: string; readonly to: string } {
  if (from.endsWith('-01') && from.slice(0, 7) === to.slice(0, 7)) {
    const lastMonthEnd = addDays(from, -1);
    const day = Math.min(Number(to.slice(8)), Number(lastMonthEnd.slice(8)));
    return { from: `${lastMonthEnd.slice(0, 7)}-01`, to: `${lastMonthEnd.slice(0, 8)}${String(day).padStart(2, '0')}` };
  }
  const days = daysBetween(from, to) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
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

/** RPT-016 (ADR-0054): how long without a purchase makes a store quiet — the reader picks. */
export const QUIET_DAYS = [14, 30, 60, 90] as const;
export type QuietDays = (typeof QUIET_DAYS)[number];

/** RPT-013 (ADR-0054): a seller's day as the dashboard names it, in the order the team is listed. */
export const TEAM_STATUSES = ['WORKING', 'ON_BREAK', 'AWAITING', 'DONE', 'NOT_IN'] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];

/** From the seller's attendance day, if any, and whether their check-in still waits for a manager (ATT-009). */
export function teamStatus(day: AttendanceDayStatus | null, awaitingAuthorisation: boolean): TeamStatus {
  if (awaitingAuthorisation) return 'AWAITING';
  switch (day) {
    case 'OPEN': return 'WORKING';
    case 'ON_BREAK': return 'ON_BREAK';
    case 'CHECKED_OUT': case 'CLOSED': return 'DONE';
    case null: return 'NOT_IN';
  }
}
