import type { SettingKey, Settings } from '../system';
import { businessDate, businessDayStart, nextBusinessDate } from '../time';
import { MEDIA_KINDS } from './policy';

/**
 * Storage management (ADR-0049, SYS-010..013). Every file the system stores —
 * the photo kinds and the delivery document PDFs — is kept for its kind's
 * period, in Riyadh calendar months, or forever. The nightly run deletes the
 * bytes of a file past its period and keeps the record.
 */
export const STORED_KINDS = [...MEDIA_KINDS, 'DELIVERY_DOCUMENT'] as const;
export type StoredKind = (typeof STORED_KINDS)[number];

/** Whole months, or forever. */
export type RetentionPeriod = number | 'FOREVER';

/** The setting that holds each kind's period. */
export const RETENTION_SETTING = {
  SELFIE: 'storage.keep_selfie',
  ODOMETER: 'storage.keep_odometer',
  STOREFRONT: 'storage.keep_storefront',
  WRITE_OFF_EVIDENCE: 'storage.keep_write_off_evidence',
  DEPOSIT_SLIP: 'storage.keep_deposit_slip',
  TRANSPORT_SLIP: 'storage.keep_transport_slip',
  PAYMENT_VOUCHER: 'storage.keep_payment_voucher',
  DELIVERY_DOCUMENT: 'storage.keep_delivery_document',
} as const satisfies Record<StoredKind, SettingKey>;

export const isStoredKind = (value: string): value is StoredKind => (STORED_KINDS as readonly string[]).includes(value);

export const retentionOf = (settings: Settings, kind: StoredKind): RetentionPeriod => settings[RETENTION_SETTING[kind]];

/** The nightly run starts at 04:00 Riyadh (worker job `media.retention`). */
export const RETENTION_RUN_HOUR = 4;

/**
 * A `YYYY-MM-DD` date plus whole months, the day clamped to the month's end —
 * exactly Postgres's `date + interval 'n months'`, which the nightly run uses.
 */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month)}-${pad(Math.min(d, last))}`;
}

/**
 * The business day a file falls due: the day it was stored plus its period.
 * A selfie taken on 15 January and kept 3 months goes in the run of 15 April;
 * one taken on 31 January and kept a month, in the run of 28 February.
 * Null when the period is forever.
 */
export function retentionDueOn(storedAt: Date, period: RetentionPeriod): string | null {
  return period === 'FOREVER' ? null : addMonths(businessDate(storedAt), period);
}

/** Whether a file is past its period on business day `today`. */
export function isPastRetention(storedAt: Date, period: RetentionPeriod, today: string): boolean {
  const due = retentionDueOn(storedAt, period);
  return due !== null && due <= today;
}

/**
 * A bound the database can use an index for: nothing stored from this
 * instant on can be due on `today`. Due means the stored day plus the period
 * is at most today, so the stored month is at most today's month less the
 * period — every due file was stored before the month after that begins.
 */
export function retentionScanBefore(months: number, today: string): Date {
  return businessDayStart(addMonths(`${today.slice(0, 7)}-01`, 1 - months));
}

/** When the next nightly run starts: 04:00 Riyadh today, or tomorrow once that has passed. */
export function nextRetentionRun(now: Date): Date {
  const at = (date: string) => new Date(businessDayStart(date).getTime() + RETENTION_RUN_HOUR * 3_600_000);
  const today = businessDate(now);
  return now < at(today) ? at(today) : at(nextBusinessDate(today));
}
