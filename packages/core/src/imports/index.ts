import { DomainError } from '../errors';
import { dec, Dec, money, toMoney, type Money } from '../numeric';

/**
 * Imported history (M13, ADR-0059): Green Agro's sellers' invoice and payment books, recorded as they were written
 * and posted to a store's account only when the seller re-verifies the store (IMP-005). Mirror packages/db.
 */

/** IMP-003: where a store-account entry or a payment came from — the app, or the books. */
export const ENTRY_ORIGINS = ['APP', 'IMPORT'] as const;
export type EntryOrigin = (typeof ENTRY_ORIGINS)[number];

/** IMP-004: a batch is loaded, or undone as a whole. */
export const IMPORT_BATCH_STATUSES = ['LOADED', 'UNDONE'] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

/**
 * IMP-002: a payment from a seller's voucher book, or money a September invoice book shows paid against an invoice
 * with no voucher for it (ADR-0059, 27 October).
 */
export const IMPORTED_PAYMENT_KINDS = ['VOUCHER', 'PAID_AT_SALE'] as const;
export type ImportedPaymentKind = (typeof IMPORTED_PAYMENT_KINDS)[number];

/**
 * IMP-001: an imported sale's figures, from its lines as written and the discount written on the invoice — a
 * total rounded down by the seller is a discount too. A line keeps its written amount even where packs × price
 * differs: that is what the store was charged (ADR-0059).
 */
export function importedSaleFigures(lineAmounts: readonly Money[], discount: Money): { subtotal: Money; total: Money } {
  if (lineAmounts.length === 0) throw new DomainError('INVALID_MONEY', { field: 'lines', value: '0' });
  for (const amount of lineAmounts) {
    if (dec(amount).isNegative()) throw new DomainError('INVALID_MONEY', { field: 'amount', value: amount });
  }
  if (dec(discount).isNegative()) throw new DomainError('INVALID_MONEY', { field: 'discount', value: discount });
  const subtotal = lineAmounts.reduce((sum, amount) => sum.plus(dec(amount)), new Dec(0));
  const total = subtotal.minus(dec(discount));
  if (!total.gt(0)) throw new DomainError('INVALID_MONEY', { field: 'total', value: total.toFixed(2) });
  return { subtotal: toMoney(subtotal), total: toMoney(total) };
}

/** IMP-002: an imported payment is money received — more than nothing. */
export function importedPaymentAmount(value: string): Money {
  const amount = money(value);
  if (!dec(amount).gt(0)) throw new DomainError('INVALID_MONEY', { field: 'amount', value });
  return amount;
}
