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
