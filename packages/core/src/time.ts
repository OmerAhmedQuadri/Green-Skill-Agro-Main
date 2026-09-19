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
