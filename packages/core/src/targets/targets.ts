import { DomainError } from '../errors';
import { Dec, dec, type Money } from '../numeric';
import { businessDate, businessDayStart } from '../time';

/**
 * TGT-003: the four figures a monthly target may set, in any combination.
 * Revenue and collections are money; packs sold and new stores are counts.
 * All four travel as decimal strings so achievement is one calculation.
 */
export const TARGET_METRICS = ['REVENUE', 'PACKS_SOLD', 'NEW_STORES', 'COLLECTED'] as const;
export type TargetMetric = (typeof TARGET_METRICS)[number];

/** A goal left out is not part of that seller's month (TGT-003). */
export type TargetGoals = Partial<Record<TargetMetric, string>>;
export type TargetActuals = Record<TargetMetric, string>;

export type MetricProgress = {
  readonly metric: TargetMetric;
  readonly goal: string;
  readonly actual: string;
  /**
   * Percentage of the goal reached, to one decimal place. Deliberately not a
   * branded `Percent`: that type caps at 100, and a seller may reach 140% of
   * their revenue goal.
   */
  readonly achievement: string;
  readonly met: boolean;
};

export type TargetProgress = {
  readonly metrics: readonly MetricProgress[];
  /** OQ-023: met only where every figure that was set reached its goal. */
  readonly met: boolean;
};

const rate = (actual: Dec, goal: Dec): string =>
  (goal.isZero() ? new Dec(100) : actual.div(goal).times(100)).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1);

/** A target with no figure set at all is not a target; it would be met by doing nothing. */
export function assertGoals(goals: TargetGoals): void {
  const set = TARGET_METRICS.filter((m) => goals[m] !== undefined);
  if (set.length === 0) throw new DomainError('TARGET_EMPTY', { goals });
  for (const metric of set) {
    const value = dec(goals[metric] ?? '0');
    if (!value.gt(0)) throw new DomainError('TARGET_NOT_POSITIVE', { metric, value: goals[metric] });
  }
}

/**
 * TGT-004, COM-004 (ADR-0042): progress figure by figure, and whether the month
 * counts as met. Only the figures the manager set are judged — the others are
 * not shown as bars to fill, so a seller is never measured against a goal
 * nobody set for them.
 */
export function targetProgress(goals: TargetGoals, actuals: TargetActuals): TargetProgress {
  const metrics = TARGET_METRICS.filter((m) => goals[m] !== undefined).map((metric) => {
    const goal = dec(goals[metric] ?? '0');
    const actual = dec(actuals[metric]);
    return { metric, goal: goal.toString(), actual: actual.toString(), achievement: rate(actual, goal), met: actual.gte(goal) };
  });
  return { metrics, met: metrics.length > 0 && metrics.every((m) => m.met) };
}

/**
 * TGT-006: mid-period pace. By day 15 of a 30-day month a seller should be
 * halfway; the flag is raised where they are below `thresholdPercent` of that
 * pace — 80% by default, so below 40% on day 15. The last day of the month is
 * not a pace question, it is the target itself, so pace only runs while days
 * remain.
 */
export function isBehindPace(
  progress: TargetProgress,
  elapsedDays: number,
  daysInMonth: number,
  thresholdPercent: number,
): boolean {
  if (progress.metrics.length === 0 || elapsedDays < 1 || elapsedDays >= daysInMonth) return false;
  const expected = new Dec(elapsedDays).div(daysInMonth).times(thresholdPercent);
  return progress.metrics.some((m) => new Dec(m.achievement).lt(expected));
}

/** The number of days in a target period, `YYYY-MM`. */
export function daysInPeriod(period: string): number {
  const [year, month] = assertPeriod(period);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Days of the period elapsed at `now`, counting the current day — 1 on the 1st. */
export function elapsedInPeriod(period: string, now: Date): number {
  const today = businessDate(now);
  if (today.slice(0, 7) !== period) return today < period ? 0 : daysInPeriod(period);
  return Number(today.slice(8));
}

/**
 * OQ-023: the month stops moving a few days after it ends, so a settlement
 * approved on the 1st or 2nd for cash collected on the 31st still lands in the
 * right month. Until this instant the figures are live; from it they are the
 * snapshot, and are never recalculated (COM-008).
 */
export function freezesAt(period: string, closeAfterDays: number): Date {
  const [year, month] = assertPeriod(period);
  const firstOfNext = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`;
  return new Date(businessDayStart(firstOfNext).getTime() + closeAfterDays * 86_400_000);
}

export function isFrozen(period: string, closeAfterDays: number, now: Date): boolean {
  return now >= freezesAt(period, closeAfterDays);
}

/**
 * COM-005 (ADR-0042): cash counts in the month it was received, once the
 * settlement carrying it is approved. Where that approval lands after the
 * month has frozen, it counts in the month it was approved instead — a closed
 * period is never reopened, so the money lands where it was found.
 */
export function attributedPeriod(collectedMonth: string, approvedMonth: string, closeAfterDays: number, approvedAt: Date): string {
  return isFrozen(collectedMonth, closeAfterDays, approvedAt) ? approvedMonth : collectedMonth;
}

export type CommissionRates = { readonly onTarget: string; readonly belowTarget: string };

export type CommissionResult = {
  /** Cash that reached the business and stayed there (OQ-023). Never below zero. */ readonly base: Money;
  /** The rate applied, or null where the seller has none set. */ readonly rate: string | null;
  /** Null where no rate is set — the screen says so rather than showing zero as a result. */ readonly commission: Money | null;
};

/**
 * COM-001..003, COM-009 (ADR-0042). The base is settled cash, less the credit
 * the business gave away without the money coming back: a credit note whose
 * value went against the store's *other* debts. The store paid for the goods
 * it returned, the business kept that cash, and a receivable was cancelled
 * instead — so the commission earned on it is reversed.
 *
 * Nothing else is subtracted here. Credit applied to the returned sale's own
 * unpaid balance was never collected, so no commission was ever earned on it;
 * and cash handed back to a store leaves the seller's hands through the cash
 * ledger, where `settledByPeriod` sees it and never settles it.
 */
export function commissionFor(
  settled: Money,
  creditAgainstOtherDebts: Money,
  met: boolean,
  rates: CommissionRates | null,
): CommissionResult {
  const base = Dec.max(dec(settled).minus(dec(creditAgainstOtherDebts)), 0);
  if (!rates) return { base: base.toFixed(2) as Money, rate: null, commission: null };
  const applied = met ? rates.onTarget : rates.belowTarget;
  return {
    base: base.toFixed(2) as Money,
    rate: applied,
    commission: base.times(dec(applied)).div(100).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2) as Money,
  };
}

function assertPeriod(period: string): readonly [number, number] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new DomainError('INVALID_PERIOD', { period });
  return [Number(period.slice(0, 4)), Number(period.slice(5))] as const;
}

/** A cash movement in the seller's hands, oldest first. */
export type CashFlow = {
  /** The Riyadh month the cash was received from the store. */ readonly period: string;
  readonly amount: Money;
};

export type SettlementApproval = { readonly at: Date; readonly period: string; readonly amount: Money };

/**
 * COM-001, COM-005 (ADR-0042). A seller declares a lump sum, not named notes,
 * so nothing in the ledger says which collections an approved settlement
 * covered. Cash in hand is a queue: the money that came in first is the money
 * handed over first. Walking the queue gives each approved riyal the date of
 * the collection it actually covers, which is what COM-005 attributes by.
 *
 * Cash the seller paid back out — a refund on a credit note — leaves the queue
 * the same way, so it is simply never settled and never earns commission.
 * That needs no second subtraction anywhere.
 */
export function settledByPeriod(
  inflows: readonly CashFlow[],
  outflows: readonly CashFlow[],
  approvals: readonly SettlementApproval[],
  closeAfterDays: number,
): ReadonlyMap<string, Money> {
  const queue = inflows.map((f) => ({ period: f.period, left: dec(f.amount) }));
  const take = (wanted: Dec, onTake?: (period: string, amount: Dec) => void): void => {
    let left = wanted;
    for (const entry of queue) {
      if (left.lte(0)) return;
      const taken = Dec.min(entry.left, left);
      if (taken.lte(0)) continue;
      entry.left = entry.left.minus(taken);
      left = left.minus(taken);
      onTake?.(entry.period, taken);
    }
  };
  // Money paid back out is consumed first, so it can never also be settled.
  for (const out of outflows) take(dec(out.amount));
  const totals = new Map<string, Dec>();
  for (const approval of approvals) {
    take(dec(approval.amount), (period, amount) => {
      const landed = attributedPeriod(period, approval.period, closeAfterDays, approval.at);
      totals.set(landed, (totals.get(landed) ?? new Dec(0)).plus(amount));
    });
  }
  return new Map([...totals].map(([period, total]) => [period, total.toFixed(2) as Money]));
}
