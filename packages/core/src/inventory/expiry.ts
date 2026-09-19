import { Dec, dec, type Quantity } from '../numeric';

/** EXP-005: which rate of sale drives the flag. */
export type RateBasis = 'TRAILING' | 'SEASONAL' | 'CONSERVATIVE';

/** Whole days from one calendar date to another. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/** EXP-001: expires within the category's warning window (or has already). */
export function timeFlag(expiresOn: string, today: string, warningDays: number): boolean {
  return daysBetween(today, expiresOn) <= warningDays;
}

/** The trailing window for rate of sale (EXP-004). */
export const RATE_WINDOW_DAYS = 30;

export type RateInput = {
  readonly held: Quantity;
  readonly expiresOn: string;
  readonly today: string;
  /** Sold from this batch in the trailing window, base units. */
  readonly soldTrailing: Quantity;
  /** Sold of this SKU in the same window a year ago, or null without a year of history (EXP-008). */
  readonly soldSeasonal: Quantity | null;
  /** Days this batch has been held. A rate needs a full window of it. */
  readonly daysHeld: number;
  readonly basis: RateBasis;
};

export type RateFlag = {
  readonly flagged: boolean;
  /** The basis actually used — trailing until a season of history exists (EXP-008). */
  readonly basisUsed: 'TRAILING' | 'SEASONAL';
  /** Days to sell what is held at that rate; null when nothing sells. */
  readonly daysToClear: number | null;
  readonly reason: 'WONT_CLEAR' | 'NO_RECENT_SALES' | null;
  /** Too soon to judge: the batch has not been held for a full window. */
  readonly tooSoon: boolean;
};

const perDay = (sold: Quantity) => dec(sold).dividedBy(RATE_WINDOW_DAYS);

/**
 * EXP-002..005, EXP-008: at the current rate of sale, will what is held clear
 * before it expires? "More conservative" takes the slower of the two rates.
 * A batch held for less than a full window has no rate yet, so it is not
 * flagged on rate (ADR-0030) — the time-based flag still applies.
 */
export function rateFlag(input: RateInput): RateFlag {
  const seasonal = input.soldSeasonal;
  const basisUsed = input.basis === 'TRAILING' || seasonal === null ? 'TRAILING' : 'SEASONAL';
  const trailingRate = perDay(input.soldTrailing);
  const rate = basisUsed === 'TRAILING' ? trailingRate
    : input.basis === 'SEASONAL' ? perDay(seasonal ?? input.soldTrailing)
      : Dec.min(trailingRate, perDay(seasonal ?? input.soldTrailing));
  const held = dec(input.held);
  if (input.daysHeld < RATE_WINDOW_DAYS || !held.gt(0)) {
    return { flagged: false, basisUsed, daysToClear: null, reason: null, tooSoon: input.daysHeld < RATE_WINDOW_DAYS };
  }
  const daysLeft = daysBetween(input.today, input.expiresOn);
  if (!rate.gt(0)) return { flagged: true, basisUsed, daysToClear: null, reason: 'NO_RECENT_SALES', tooSoon: false };
  const daysToClear = held.dividedBy(rate).ceil().toNumber();
  return { flagged: daysToClear > daysLeft, basisUsed, daysToClear, reason: daysToClear > daysLeft ? 'WONT_CLEAR' : null, tooSoon: false };
}
