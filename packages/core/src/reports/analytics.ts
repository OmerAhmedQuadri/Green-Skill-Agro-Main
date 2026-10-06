import { DomainError } from '../errors';
import { Dec, dec, toMoney, type Money } from '../numeric';
import { businessDayStart, isCalendarDate } from '../time';

/** ADR-0048: the longest range one view covers — a year, so no view becomes a scan of everything. */
export const MAX_RANGE_DAYS = 366;
/** ADR-0048: up to two months the chart goes day by day; beyond that, month by month. */
export const DAILY_UP_TO_DAYS = 62;

const DAY_MS = 86_400_000;

/** A calendar date as days since 1970 — calendar arithmetic, no time zone in it. */
const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

const isDate = isCalendarDate;

export type AnalyticsRange = {
  readonly from: string; readonly to: string; readonly days: number;
  /** How the chart groups the range. */ readonly bucket: 'DAY' | 'MONTH';
  /** Riyadh midnight before `from` and after `to`: a moment counts when `start <= t < end`. */ readonly start: Date; readonly end: Date;
};

/**
 * ADR-0048: whole Riyadh business days, `from` and `to` both included, no
 * longer than a year. By day up to two months, by month beyond — a year of
 * days is 365 bars nobody can read.
 */
export function analyticsRange(from: string, to: string): AnalyticsRange {
  if (!isDate(from)) throw new DomainError('INVALID_DATE', { field: 'from', value: from });
  if (!isDate(to)) throw new DomainError('INVALID_DATE', { field: 'to', value: to });
  const days = dayNumber(to) - dayNumber(from) + 1;
  if (days < 1) throw new DomainError('INVALID_DATE', { field: 'to', value: to, from });
  if (days > MAX_RANGE_DAYS) throw new DomainError('RANGE_TOO_LONG', { days, max: MAX_RANGE_DAYS });
  return {
    from, to, days, bucket: days <= DAILY_UP_TO_DAYS ? 'DAY' : 'MONTH',
    start: businessDayStart(from), end: businessDayStart(dateOf(dayNumber(to) + 1)),
  };
}

const nextMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/** Every period of the range in order — days or months — so a chart has a place, at zero, where nothing sold. */
export function rangePeriods(range: AnalyticsRange): string[] {
  const out: string[] = [];
  if (range.bucket === 'DAY') {
    for (let day = dayNumber(range.from); day <= dayNumber(range.to); day += 1) out.push(dateOf(day));
  } else {
    for (let month = range.from.slice(0, 7); month <= range.to.slice(0, 7); month = nextMonth(month)) out.push(month);
  }
  return out;
}

/**
 * ADR-0048: the calendar month a range covers exactly — its first day to its
 * last — or null. Targets and commission are monthly, so they are shown only
 * for a range that is one whole month.
 */
export function wholeMonthOf(range: AnalyticsRange): string | null {
  const month = range.from.slice(0, 7);
  if (range.from !== `${month}-01` || range.to.slice(0, 7) !== month) return null;
  return dateOf(dayNumber(range.to) + 1).slice(0, 7) === month ? null : month;
}

/** RPT-008: how far past its due date a debt is, in the usual bands. */
export const AGEING_BANDS = ['NOT_DUE', 'DAYS_1_30', 'DAYS_31_60', 'DAYS_61_90', 'OVER_90'] as const;
export type AgeingBand = (typeof AGEING_BANDS)[number];

export function ageingBand(dueOn: string, today: string): AgeingBand {
  const late = dayNumber(today) - dayNumber(dueOn);
  if (late <= 0) return 'NOT_DUE';
  if (late <= 30) return 'DAYS_1_30';
  if (late <= 60) return 'DAYS_31_60';
  if (late <= 90) return 'DAYS_61_90';
  return 'OVER_90';
}

export type Ageing = Readonly<Record<AgeingBand, Money>> & { readonly total: Money };

/**
 * RPT-008: what a store owes, split by how late each part is. Days past the
 * due date, not past the grace days: grace decides when a store is blocked
 * (CRD-004); ageing reports how late the money is.
 */
export function ageDebts(debits: readonly { readonly dueOn: string; readonly open: Money }[], today: string): Ageing {
  const bands = new Map<AgeingBand, Dec>(AGEING_BANDS.map((b) => [b, new Dec(0)]));
  let total = new Dec(0);
  for (const debit of debits) {
    const band = ageingBand(debit.dueOn, today);
    bands.set(band, (bands.get(band) ?? new Dec(0)).plus(dec(debit.open)));
    total = total.plus(dec(debit.open));
  }
  const money = (band: AgeingBand) => toMoney(bands.get(band) ?? new Dec(0));
  return {
    NOT_DUE: money('NOT_DUE'), DAYS_1_30: money('DAYS_1_30'), DAYS_31_60: money('DAYS_31_60'),
    DAYS_61_90: money('DAYS_61_90'), OVER_90: money('OVER_90'), total: toMoney(total),
  };
}
