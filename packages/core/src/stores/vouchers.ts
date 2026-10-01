import { DomainError } from '../errors';

/** Arabic-Indic and Eastern Arabic-Indic digits, as a phone keyboard may type them. */
const DIGITS = new Map([...'٠١٢٣٤٥٦٧٨٩', ...'۰۱۲۳۴۵۶۷۸۹'].map((d, i) => [d, String(i % 10)]));

/**
 * ADR-0047: the number printed on a voucher, as it is kept — so the same slip
 * reads the same whichever way it was typed, and a voucher used twice is
 * caught. Digits in either script, spaces dropped, letters in capitals, and an
 * all-digit number without its leading zeros ("000123" is voucher 123).
 * Letters and digits, with - or / between them; up to 40 characters.
 */
export function voucherNumber(typed: string): string {
  const compact = typed.replace(/[٠-٩۰-۹]/g, (d) => DIGITS.get(d) ?? d).replace(/\s+/g, '').toUpperCase();
  const number = /^\d+$/.test(compact) ? compact.replace(/^0+(?=\d)/, '') : compact;
  if (!/^[A-Z0-9](?:[A-Z0-9/-]{0,38}[A-Z0-9])?$/.test(number)) throw new DomainError('INVALID_VOUCHER_NUMBER', { value: typed });
  return number;
}
