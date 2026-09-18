import { DomainError } from '../errors';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date as `YYYY-MM-DD` (CONVENTIONS §4), checked to exist. */
export function isoDate(raw: string, field: string): string {
  const m = ISO_DATE.exec(raw.trim());
  const [, y, mo, d] = m ?? [];
  const date = m ? new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))) : null;
  if (!date || date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) {
    throw new DomainError('INVALID_DATE', { field, value: raw });
  }
  return raw.trim();
}

/**
 * RCV-006: expiry applied from a shelf-life period to the manufacturing date.
 * A month is a calendar month; a day that does not exist in the target month
 * falls back to its last day (31 January + 1 month = 28 or 29 February).
 */
export function expiryFromShelfLife(manufacturedOn: string, period: { months: number } | { years: number }): string {
  const months = 'years' in period ? period.years * 12 : period.months;
  if (!Number.isInteger(months) || months < 1 || months > 600) throw new DomainError('INVALID_SHELF_LIFE', { period });
  const [y, m, d] = isoDate(manufacturedOn, 'manufacturedOn').split('-').map(Number) as [number, number, number];
  const targetMonth = m - 1 + months;
  const year = y + Math.floor(targetMonth / 12);
  const month = targetMonth % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * STK-001/002: a batch is SKU + LOT + MFD + expiry. LOT numbers are the
 * vendor's reference, kept as written apart from surrounding spaces.
 */
export function batchIdentity(input: { lotNumber?: string | null; manufacturedOn?: string | null; expiresOn?: string | null }) {
  const lotNumber = input.lotNumber?.trim().replace(/\s+/g, ' ') || null;
  if (lotNumber && lotNumber.length > 60) throw new DomainError('INVALID_LOT', { lotNumber });
  const manufacturedOn = input.manufacturedOn ? isoDate(input.manufacturedOn, 'manufacturedOn') : null;
  const expiresOn = input.expiresOn ? isoDate(input.expiresOn, 'expiresOn') : null;
  if (manufacturedOn && expiresOn && expiresOn <= manufacturedOn) {
    throw new DomainError('EXPIRY_BEFORE_MANUFACTURE', { manufacturedOn, expiresOn });
  }
  return { lotNumber, manufacturedOn, expiresOn };
}
