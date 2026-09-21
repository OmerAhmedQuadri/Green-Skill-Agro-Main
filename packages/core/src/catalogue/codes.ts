import { DomainError, type ErrorCode } from '../errors';
import { Dec } from '../numeric';
import type { CountUnit } from './template';

export const PACKAGING_TYPES = ['CAN', 'POUCH', 'BAG'] as const; // CAT-009
export type Packaging = (typeof PACKAGING_TYPES)[number];

/** A SKU's pack size in base units (ADR-0015): grams by weight, or a whole count (CAT-010). */
export type PackSize =
  | { readonly measure: 'WEIGHT'; readonly packWeightG: string }
  | { readonly measure: 'COUNT'; readonly packCount: number };

// Codes are identifiers people read aloud and print: capitals, digits, and
// inner hyphens or dots only.
const CODE = /^[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?$/;

function normaliseCode(raw: string, max: number, error: ErrorCode): string {
  const code = raw.trim().toUpperCase();
  if (code.length > max || !CODE.test(code)) throw new DomainError(error, { code: raw });
  return code;
}

/** CAT-008: a manually entered SKU code. Spaces are refused, not stripped. */
export const normaliseSkuCode = (raw: string): string => normaliseCode(raw, 40, 'INVALID_SKU_CODE');

/** VEN-001: the vendor code is Green Skill Agro's own choice, e.g. `VEN-7K4M`. */
export const normaliseVendorCode = (raw: string): string => normaliseCode(raw, 20, 'INVALID_VENDOR_CODE');

const letters = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The size part of a code: `5KG`, `500G`, `0.5G`, `500S` (seeds), `1PC` (pieces). */
export function sizeCode(size: PackSize, countUnit: CountUnit): string {
  if (size.measure === 'COUNT') return `${size.packCount}${countUnit === 'SEED' ? 'S' : 'PC'}`;
  const grams = new Dec(size.packWeightG);
  if (grams.gte(1000) && grams.mod(1000).isZero()) return `${grams.dividedBy(1000).toString()}KG`;
  return `${grams.toString()}G`;
}

/**
 * CAT-008: the code is generated from product, variety and pack size, e.g.
 * Okra / Parbhani Kranti / 5 kg → `OKRA-PK-5KG`. The product gives four
 * letters, and the variety its initials: the first letters of its first two
 * words, or the first two letters of a single word. A product without
 * varieties has no middle part.
 */
export function generateSkuCode(input: {
  readonly productNameEn: string; readonly varietyNameEn: string | null; readonly size: PackSize; readonly countUnit: CountUnit;
}): string {
  const product = letters(input.productNameEn).slice(0, 4) || 'SKU';
  const words = (input.varietyNameEn ?? '').split(/[^A-Za-z0-9]+/).map(letters).filter(Boolean);
  const variety = words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : (words[0] ?? '').slice(0, 2);
  return [product, variety, sizeCode(input.size, input.countUnit)].filter(Boolean).join('-');
}

const PACKAGING_LETTER: Record<Packaging, string> = { CAN: 'C', POUCH: 'P', BAG: 'B' };

/**
 * Two SKUs of one variety at one size differ only by packaging, which the base
 * code leaves out. On a clash the packaging letter is appended, then a number.
 */
export function resolveSkuCode(base: string, packaging: Packaging, taken: (code: string) => boolean): string {
  if (!taken(base)) return base;
  const withPackaging = `${base}-${PACKAGING_LETTER[packaging]}`;
  if (!taken(withPackaging)) return withPackaging;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${withPackaging}${n}`;
    if (!taken(candidate)) return candidate;
  }
  throw new DomainError('DUPLICATE_CODE', { code: base });
}

/**
 * Pack weight as entered — grams or kilograms — in grams (ADR-0015). Kilograms
 * are a display unit only. CAT-010/011: at least 0.1 g, and no finer than the
 * three decimals a quantity can hold.
 */
export function packWeightGrams(value: string, unit: 'G' | 'KG'): string {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(value)) throw new DomainError('INVALID_PACK_SIZE', { value });
  const grams = new Dec(value).times(unit === 'KG' ? 1000 : 1);
  if (grams.lt('0.1') || grams.decimalPlaces() > 3 || grams.gt('999999999')) {
    throw new DomainError('INVALID_PACK_SIZE', { value, unit });
  }
  return grams.toFixed(3);
}

export function packCountOf(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000_000) throw new DomainError('INVALID_PACK_SIZE', { value });
  return value;
}
