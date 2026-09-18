import Decimal from 'decimal.js';
import { DomainError } from './errors';

/**
 * Exact arithmetic (ADR-0003). Money, quantities and percentages travel as
 * branded decimal strings — the same shape node-postgres returns for `numeric`
 * — and are only ever computed on as `Decimal`. A JavaScript `number` never
 * holds one of these values.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** SAR, at most 2 decimal places. Postgres `numeric(14,2)`. */
export type Money = Brand<string, 'Money'>;
/** Stock in base units — grams or seeds (ADR-0015). Postgres `numeric(14,3)`. */
export type Quantity = Brand<string, 'Quantity'>;
/** 0–100 with at most 3 decimal places — never 0–1. Postgres `numeric(6,3)`. */
export type Percent = Brand<string, 'Percent'>;

/** Decimal configured for this domain: generous precision, half-up rounding. */
export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = Decimal;

const MONEY = /^-?\d{1,12}(\.\d{1,2})?$/;
const QUANTITY = /^-?\d{1,11}(\.\d{1,3})?$/;
const PERCENT = /^\d{1,3}(\.\d{1,3})?$/;

export function money(value: string): Money {
  if (!MONEY.test(value)) throw new DomainError('INVALID_MONEY', { value });
  return value as Money;
}

export function quantity(value: string): Quantity {
  if (!QUANTITY.test(value)) throw new DomainError('INVALID_QUANTITY', { value });
  return value as Quantity;
}

export function percent(value: string): Percent {
  if (!PERCENT.test(value) || new Dec(value).gt(100)) {
    throw new DomainError('INVALID_PERCENT', { value });
  }
  return value as Percent;
}

/** Round half-up to 2 places — only at the end of a calculation (CONVENTIONS §4). */
export function toMoney(value: Dec): Money {
  return money(value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));
}

export function toQuantity(value: Dec): Quantity {
  if (value.decimalPlaces() > 3) throw new DomainError('INVALID_QUANTITY', { value: value.toString() });
  return quantity(value.toFixed(3));
}

export const dec = (value: Money | Quantity | Percent | string): Dec => new Dec(value);
