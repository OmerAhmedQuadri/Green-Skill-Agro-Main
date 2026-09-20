import type { RateBasis } from '../inventory/expiry';
import { Dec, dec } from '../numeric';

/**
 * RPT-004..006 (§11): with a thirty to forty day import lead time, the question
 * is not what is in the warehouse today but what will be there when the next
 * shipment lands. The window the rate of sale is measured over is longer than
 * the expiry flag's, because an ordering decision made on one slow fortnight is
 * an expensive mistake.
 */
export const DEMAND_WINDOW_DAYS = 90;

export type ForecastInput = {
  /** Packs held anywhere the business owns them — warehouse, vehicles, released but unconfirmed. */
  readonly onHand: number;
  /** RPT-004: packs already ordered and expected before the projection date. */
  readonly inTransit: number;
  /** Packs sold in the trailing window. */
  readonly soldTrailing: string;
  /** The same window a year ago; null until there is a season of history (RPT-011). */
  readonly soldSeasonal: string | null;
  readonly basis: RateBasis;
  readonly leadTimeDays: number;
  /** OQ-023: the cushion, in days of cover. Null where this SKU is not forecast. */
  readonly safetyCoverDays: number;
};

export type Reorder = {
  /** Packs a day, to three places. */
  readonly perDay: string;
  /** EXP-008's vocabulary: seasonal where there is a season to compare with, else trailing. */
  readonly basisUsed: 'TRAILING' | 'SEASONAL';
  /**
   * RPT-011: no year of history stands behind this figure, so it is a guide
   * rather than a projection, and the screen must say so.
   */
  readonly guide: boolean;
  /** Packs expected to be left when the shipment lands. Negative means running out before then. */
  readonly projectedAtArrival: number;
  /** Packs the safety cover asks for at this rate. */
  readonly safetyLevel: number;
  /** RPT-004: packs to order. Zero where the projection stays above the safety level. */
  readonly suggested: number;
};

/**
 * RPT-004..006, RPT-011 (ADR-0042): what to order, and why. Advisory only —
 * RPT-005 is explicit that the system never places an order, so this returns a
 * figure and the workings behind it for a manager to accept, change or ignore.
 */
export function reorderFor(input: ForecastInput): Reorder {
  const seasonal = input.soldSeasonal;
  const basisUsed = input.basis === 'TRAILING' || seasonal === null ? 'TRAILING' : 'SEASONAL';
  const trailingRate = dec(input.soldTrailing).dividedBy(DEMAND_WINDOW_DAYS);
  const seasonalRate = dec(seasonal ?? input.soldTrailing).dividedBy(DEMAND_WINDOW_DAYS);
  const perDay = basisUsed === 'TRAILING' ? trailingRate
    : input.basis === 'SEASONAL' ? seasonalRate
      // "More conservative" for an order means the faster rate: running out costs more than holding.
      : Dec.max(trailingRate, seasonalRate);

  const willSell = perDay.times(input.leadTimeDays);
  const projected = new Dec(input.onHand).plus(input.inTransit).minus(willSell);
  const safety = perDay.times(input.safetyCoverDays).ceil();
  const shortfall = safety.minus(projected);
  return {
    perDay: perDay.toDecimalPlaces(3, Dec.ROUND_HALF_UP).toFixed(3),
    basisUsed,
    guide: seasonal === null,
    projectedAtArrival: projected.floor().toNumber(),
    safetyLevel: safety.toNumber(),
    suggested: Dec.max(shortfall.ceil(), 0).toNumber(),
  };
}

export type TrendPoint = { readonly period: string; readonly packs: number; readonly revenue: string };

export type Movement = {
  readonly period: string;
  readonly packs: number;
  readonly revenue: string;
  /** The period compared against — the month before, or the same month last year. */
  readonly against: string | null;
  /** Change in revenue against that period, as a percentage; null where there is nothing to compare. */
  readonly revenueChange: string | null;
  readonly packsChange: string | null;
};

const change = (now: string | number, before: string | number): string | null => {
  const was = dec(String(before));
  if (!was.gt(0)) return null;
  return dec(String(now)).minus(was).dividedBy(was).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1);
};

/**
 * RPT-001, RPT-002: month on month, and against the same month a year ago.
 * A period with nothing to compare against carries nulls rather than a
 * fabricated 100% — a first month is not infinite growth.
 */
export function movements(points: readonly TrendPoint[], compare: 'PREVIOUS' | 'YEAR_AGO'): Movement[] {
  const by = new Map(points.map((p) => [p.period, p]));
  return points.map((point) => {
    const against = compare === 'YEAR_AGO' ? yearBefore(point.period) : monthBefore(point.period);
    const previous = by.get(against);
    return {
      period: point.period, packs: point.packs, revenue: point.revenue,
      against: previous ? against : null,
      revenueChange: previous ? change(point.revenue, previous.revenue) : null,
      packsChange: previous ? change(point.packs, previous.packs) : null,
    };
  });
}

export function monthBefore(period: string): string {
  const [year, month] = [Number(period.slice(0, 4)), Number(period.slice(5))];
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

export function yearBefore(period: string): string {
  return `${Number(period.slice(0, 4)) - 1}-${period.slice(5)}`;
}
