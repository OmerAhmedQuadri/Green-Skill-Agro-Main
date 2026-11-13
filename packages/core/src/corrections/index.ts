import { DomainError } from '../errors';
import { isoDate } from '../inventory';
import { dec, money, quantity, toMoney, type Money, type Percent } from '../numeric';
import { lineAmounts, sumMoney } from '../sales';
import { voucherNumber } from '../stores';

/**
 * Correcting history (M13, ADR-0059): only a Super Admin, only inside a personal correction session opened with
 * their password and a reason. With no session open, nobody can correct anything. Mirror packages/db.
 */

/** COR-001: a session ends an hour after it opens, unless it is closed sooner. */
export const CORRECTION_SESSION_MS = 60 * 60 * 1000;

/** COR-003: how the session's reason was settled when it closed. EDITED keeps the original, shown struck through. */
export const CORRECTION_CLOSINGS = ['KEPT', 'ADDED', 'EDITED'] as const;
export type CorrectionClosing = (typeof CORRECTION_CLOSINGS)[number];

/**
 * OPEN   — corrections may be made in it
 * ENDED  — its hour ran out; it waits for its owner to settle the reason, and no correction may be made
 * CLOSED — its reason settled
 */
export type CorrectionSessionState = 'OPEN' | 'ENDED' | 'CLOSED';

export function correctionSessionEnds(openedAt: Date): Date {
  return new Date(openedAt.getTime() + CORRECTION_SESSION_MS);
}

export function correctionSessionState(session: { endsAt: Date; closedAt: Date | null }, now: Date): CorrectionSessionState {
  if (session.closedAt) return 'CLOSED';
  return now < session.endsAt ? 'OPEN' : 'ENDED';
}

/** When a session stopped: when it was closed, or at the end of its hour if it ran out first. */
export function correctionSessionEndedAt(session: { endsAt: Date }, closedAt: Date): Date {
  return closedAt < session.endsAt ? closedAt : session.endsAt;
}

/** COR-001, COR-002: a reason is required, kept as written without its outer spaces. */
export function correctionReason(value: string | null | undefined, field = 'reason'): string {
  const reason = value?.trim() ?? '';
  if (!reason) throw new DomainError('REASON_REQUIRED', { field });
  return reason;
}

/**
 * COR-003: settling the reason at closing. Adding or editing needs the new words; an "edit" that changes nothing
 * keeps the reason.
 */
export function settleCorrectionReason(
  reason: string, closing: CorrectionClosing, text: string | null | undefined,
): { closing: CorrectionClosing; text: string | null } {
  if (closing === 'KEPT') return { closing, text: null };
  const words = correctionReason(text, 'closingText');
  if (closing === 'EDITED' && words === reason) return { closing: 'KEPT', text: null };
  return { closing, text: words };
}

/** COR-005: what a store-account correction corrects — a bill the store owes, or a payment it made. */
export const STORE_CORRECTION_KINDS = ['BILL', 'PAYMENT'] as const;
export type StoreCorrectionKind = (typeof STORE_CORRECTION_KINDS)[number];

/**
 * COR-005 (ADR-0059, amended): which entries of a store's account a correction may touch.
 *   - a payment;
 *   - a bill that is a manual balance adjustment, an imported sale, or itself a corrected bill.
 * A bill from a sale made in the app is corrected through the sale (step e), so the account and the delivery
 * document cannot come to disagree by accident. Credit notes, the entries a correction posts to reverse another,
 * and debt put back for a transfer that never arrived are not corrected here.
 */
export function storeEntryKind(entry: { entryType: string; amount: Money | string; referenceType: string }): StoreCorrectionKind {
  if (entry.referenceType === 'CORRECTION_REVERSAL') throw new DomainError('NOT_CORRECTABLE', { reason: 'REVERSAL' });
  if (entry.entryType === 'PAYMENT') return 'PAYMENT';
  if (dec(entry.amount).gt(0)) {
    if (entry.referenceType === 'SALE') throw new DomainError('CORRECT_THROUGH_SALE');
    if (['ADJUSTMENT', 'IMPORTED_SALE', 'CORRECTION'].includes(entry.referenceType)) return 'BILL';
  }
  throw new DomainError('NOT_CORRECTABLE', { reason: entry.referenceType });
}

/** An entry's values as a correction sees them: its amount, its Riyadh date, its store, and a payment's voucher. */
export type StoreEntryValues = {
  readonly amount: Money; readonly date: string; readonly storeId: string; readonly voucherNumber: string | null;
};

export type StoreEntryChange = {
  readonly amount?: string | null | undefined; readonly date?: string | null | undefined; readonly storeId?: string | null | undefined;
  readonly voucherNumber?: string | null | undefined; readonly remove?: boolean | undefined;
};

/**
 * COR-005: the values a correction leaves, or null when it removes the entry. What is not given stays as it was; a
 * bill has no voucher; a date is not after today; and something must change.
 */
export function correctedStoreEntry(
  kind: StoreCorrectionKind, original: StoreEntryValues, change: StoreEntryChange, today: string,
): StoreEntryValues | null {
  if (change.remove) return null;
  const amount = toMoney(dec(change.amount?.trim() ? money(change.amount) : original.amount));
  if (!dec(amount).gt(0)) throw new DomainError('INVALID_MONEY', { field: 'amount', value: amount });
  const date = change.date?.trim() ? isoDate(change.date.trim(), 'date') : original.date;
  if (date > today) throw new DomainError('INVALID_DATE', { field: 'date', value: date });
  const storeId = change.storeId?.trim() || original.storeId;
  let voucher = original.voucherNumber;
  if (change.voucherNumber?.trim()) {
    if (kind === 'BILL') throw new DomainError('NOT_CORRECTABLE', { field: 'voucherNumber' });
    voucher = voucherNumber(change.voucherNumber);
  }
  const after = { amount, date, storeId, voucherNumber: voucher };
  if (dec(amount).eq(dec(original.amount)) && date === original.date && storeId === original.storeId && voucher === original.voucherNumber) {
    throw new DomainError('NOTHING_TO_CORRECT');
  }
  return after;
}

/** The same moment of the day, on another Riyadh date — where a corrected entry sits when its date changes. */
export function onDate(instant: Date, fromDate: string, toDate: string): Date {
  const days = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000;
  return new Date(instant.getTime() + days * 86_400_000);
}

/**
 * COR-006 (ADR-0059, amended 28 October): a sale made in the app as a correction sees it — its store, and each
 * line's packs, price and the discount given, with what they come to.
 */
export type SaleLineValues = {
  readonly lineId: string; readonly skuId: string; readonly packs: number; readonly unitPrice: Money; readonly discount: Percent;
  readonly gross: Money; readonly discountAmount: Money; readonly total: Money;
};
export type SaleValues = {
  readonly storeId: string | null; readonly lines: readonly SaleLineValues[]; readonly gross: Money; readonly discount: Money; readonly total: Money;
};

/** What a sale correction changes: lines' packs and prices, the store, or the whole sale away. */
export type SaleChange = {
  readonly lines?: readonly { readonly lineId: string; readonly packs?: number | undefined; readonly unitPrice?: string | undefined }[] | undefined;
  readonly storeId?: string | null | undefined;
  readonly remove?: boolean | undefined;
};

/**
 * COR-006: the sale a correction leaves, or null when it removes the sale. Each line keeps its discount; a line set
 * to 0 packs stays, as nothing sold. A price is above zero, an open sale has no store to move to, some line must
 * still sell something (otherwise the sale is removed), and something must change.
 */
export function correctedSale(original: SaleValues, change: SaleChange): SaleValues | null {
  if (change.remove) return null;
  const given = new Map((change.lines ?? []).map((l) => [l.lineId, l]));
  for (const id of given.keys()) {
    if (!original.lines.some((l) => l.lineId === id)) throw new DomainError('NOT_FOUND', { entity: 'sale_line', id });
  }
  const lines = original.lines.map((line): SaleLineValues => {
    const g = given.get(line.lineId);
    if (!g) return line;
    const packs = g.packs ?? line.packs;
    if (!Number.isSafeInteger(packs) || packs < 0) throw new DomainError('INVALID_PACK_COUNT', { value: packs });
    const unitPrice = g.unitPrice?.trim() ? toMoney(dec(money(g.unitPrice.trim()))) : line.unitPrice;
    if (!dec(unitPrice).gt(0)) throw new DomainError('INVALID_MONEY', { field: 'unitPrice', value: unitPrice });
    return { ...line, packs, unitPrice, ...lineAmounts(unitPrice, packs, line.discount) };
  });
  const storeId = change.storeId?.trim() || original.storeId;
  if (storeId !== original.storeId && original.storeId === null) throw new DomainError('NOT_CORRECTABLE', { field: 'storeId' });
  const total = sumMoney(lines.map((l) => l.total));
  if (!dec(total).gt(0)) throw new DomainError('EMPTY_SALE');
  const same = storeId === original.storeId
    && lines.every((l, i) => l.packs === original.lines[i]?.packs && dec(l.unitPrice).eq(dec(original.lines[i]?.unitPrice ?? '0')));
  if (same) throw new DomainError('NOTHING_TO_CORRECT');
  return { storeId, lines, gross: sumMoney(lines.map((l) => l.gross)), discount: sumMoney(lines.map((l) => l.discountAmount)), total };
}

/** COR-006: an imported sale's lines as a correction sees them — as written, with the SKU each names where one matches. */
export type ImportedLineValues = {
  readonly item: string; readonly skuId: string | null; readonly packs: string; readonly unitPrice: Money; readonly amount: Money;
};
export type ImportedSaleValues = {
  readonly lines: readonly ImportedLineValues[]; readonly subtotal: Money; readonly discount: Money; readonly total: Money;
};
export type ImportedSaleChange = {
  readonly lines: readonly {
    readonly item: string; readonly skuId?: string | null | undefined; readonly packs: string; readonly unitPrice: string;
    /** What the store was charged for the line; packs × price when not given. */ readonly amount?: string | null | undefined;
  }[];
  readonly discount?: string | null | undefined;
};

/**
 * COR-006 (ADR-0059): an imported sale's corrected lines — product, packs, price and amount — and its total, the
 * lines less the discount. Only the bill changes: these lines never touch stock (IMP-006). Packs are above zero (up
 * to three decimals, as the books write them), the total above zero, and something must change.
 */
export function correctedImportedSale(original: ImportedSaleValues, change: ImportedSaleChange): ImportedSaleValues {
  if (change.lines.length === 0) throw new DomainError('EMPTY_SALE');
  const lines = change.lines.map((l, i): ImportedLineValues => {
    const item = l.item.trim();
    if (!item) throw new DomainError('INVALID_NAME', { field: `lines.${i}.item` });
    const packs = quantity(l.packs.trim());
    if (!dec(packs).gt(0)) throw new DomainError('INVALID_QUANTITY', { field: `lines.${i}.packs`, value: packs });
    const unitPrice = toMoney(dec(money(l.unitPrice.trim())));
    if (dec(unitPrice).isNegative()) throw new DomainError('INVALID_MONEY', { field: `lines.${i}.unitPrice`, value: unitPrice });
    const amount = l.amount?.trim() ? toMoney(dec(money(l.amount.trim()))) : toMoney(dec(packs).times(dec(unitPrice)));
    if (dec(amount).isNegative()) throw new DomainError('INVALID_MONEY', { field: `lines.${i}.amount`, value: amount });
    return { item, skuId: l.skuId?.trim() || null, packs: dec(packs).toFixed(3), unitPrice, amount };
  });
  const discount = change.discount?.trim() ? toMoney(dec(money(change.discount.trim()))) : original.discount;
  if (dec(discount).isNegative()) throw new DomainError('INVALID_MONEY', { field: 'discount', value: discount });
  const subtotal = sumMoney(lines.map((l) => l.amount));
  const total = toMoney(dec(subtotal).minus(dec(discount)));
  if (!dec(total).gt(0)) throw new DomainError('EMPTY_SALE');
  const sameLine = (a: ImportedLineValues, b: ImportedLineValues | undefined) => b !== undefined && a.item === b.item && a.skuId === b.skuId
    && dec(a.packs).eq(dec(b.packs)) && dec(a.unitPrice).eq(dec(b.unitPrice)) && dec(a.amount).eq(dec(b.amount));
  if (lines.length === original.lines.length && lines.every((l, i) => sameLine(l, original.lines[i])) && dec(discount).eq(dec(original.discount))) {
    throw new DomainError('NOTHING_TO_CORRECT');
  }
  return { lines, subtotal, discount, total };
}
