import { DomainError } from '../errors';
import { dec, Dec, money, toMoney, type Money } from '../numeric';

/**
 * Imported history (M13, ADR-0059): Green Agro's sellers' invoice and payment books, recorded as they were written
 * and posted to a store's account only when the seller re-verifies the store (IMP-005). Mirror packages/db.
 */

/** IMP-003: where a store-account entry or a payment came from — the app, or the books. */
export const ENTRY_ORIGINS = ['APP', 'IMPORT'] as const;
export type EntryOrigin = (typeof ENTRY_ORIGINS)[number];

/** IMP-007: in sales analytics, the one row for imported lines that name no catalogue product. */
export const IMPORTED_UNMATCHED_KEY = 'UNMATCHED';

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

/**
 * IMP-009 (ADR-0059): what the import could not settle, for the Super Admin — each about a store, an imported sale or
 * an imported payment, with the figures that explain it. Written by our tools into the import file.
 *   VOUCHER_MISSING                a payment with no voucher number
 *   VOUCHER_NOT_IN_BOOKS           a sale paid by a voucher found in neither voucher book    { voucher }
 *   NAME_JOINED_BY_GUESS           a store name joined to a store on spelling alone          { written }
 *   PAYMENT_NO_STORE               a payment whose name matches no store                    { written }
 *   PAYMENT_HELD_BACK              a payment held unassigned: it would take its store below nothing { store }
 *   NAMES_MAY_BE_ONE_STORE         two stores whose names may be one                        { other }
 *   LINE_DOES_NOT_ADD_UP           a line whose packs × price is not its amount              { line, computed }
 *   LINE_NOT_IN_CATALOGUE          a line naming no catalogue product                       { line, item }
 *   LINE_READ_AS_OTHER_PACK        a line priced like one product but read as another       { line, item }
 *   DATE_DIFFERS_FROM_STATEMENT    a date the September statement gives otherwise           { statement }
 *   RETURN_NOT_IMPORTED            a return on the statements, left for a correction         { amount, date }
 *   BALANCE_DIFFERS_FROM_STATEMENT a store whose balance differs from its September statement { books, statement }
 */
export const IMPORT_WARNING_KINDS = [
  'VOUCHER_MISSING', 'VOUCHER_NOT_IN_BOOKS', 'NAME_JOINED_BY_GUESS', 'PAYMENT_NO_STORE', 'PAYMENT_HELD_BACK', 'NAMES_MAY_BE_ONE_STORE',
  'LINE_DOES_NOT_ADD_UP', 'LINE_NOT_IN_CATALOGUE', 'LINE_READ_AS_OTHER_PACK', 'DATE_DIFFERS_FROM_STATEMENT', 'RETURN_NOT_IMPORTED',
  'BALANCE_DIFFERS_FROM_STATEMENT',
] as const;
export type ImportWarningKind = (typeof IMPORT_WARNING_KINDS)[number];

/** IMP-009: a warning is kept as it is, with a note, or marked corrected — which needs a correction session. */
export const IMPORT_WARNING_RESOLUTIONS = ['KEPT', 'CORRECTED'] as const;
export type ImportWarningResolution = (typeof IMPORT_WARNING_RESOLUTIONS)[number];
