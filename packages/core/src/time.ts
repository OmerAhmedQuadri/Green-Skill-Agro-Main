/**
 * The business day runs on Riyadh time (CONVENTIONS §4). "Today", target
 * periods and job schedules all use it. Time is always passed in — core never
 * reads the clock.
 */
export const BUSINESS_TIME_ZONE = 'Asia/Riyadh';

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Riyadh calendar date of an instant, as `YYYY-MM-DD`. */
export function businessDate(instant: Date): string {
  return dateFormat.format(instant);
}

/** The Riyadh calendar month of an instant, as `YYYY-MM` — a target period. */
export function businessMonth(instant: Date): string {
  return businessDate(instant).slice(0, 7);
}

/**
 * The instant a Riyadh business day starts. Saudi Arabia keeps UTC+3 all year
 * (no daylight saving), so the offset is fixed.
 */
export function businessDayStart(date: string): Date {
  return new Date(`${date}T00:00:00+03:00`);
}

/** The next business day after `date`, as `YYYY-MM-DD`. */
export function nextBusinessDate(date: string): string {
  return businessDate(new Date(businessDayStart(date).getTime() + 36 * 3_600_000));
}

/** A target period or report month, `YYYY-MM`. */
export function isBusinessMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/**
 * The first instant of a Riyadh month and of the month after it, so a monthly
 * figure counts `from <= t < to`. One definition: a copy that drifted to UTC
 * would disagree with the rest for three hours on a month's last night.
 */
export function businessMonthRange(month: string): { readonly from: Date; readonly to: Date } {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
  return { from: businessDayStart(`${month}-01`), to: businessDayStart(`${next}-01`) };
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD`, and a date that exists — JavaScript reads 30 February as 2 March. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** A calendar date plus whole days — calendar arithmetic, no time zone in it. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

