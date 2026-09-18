import type { Template } from '../catalogue';
import { DomainError, isDomainError, type ErrorCode } from '../errors';
import { batchIdentity, expiryFromShelfLife } from '../inventory';
import { money, type Money } from '../numeric';

/** What a receipt line needs to know about its SKU's product. */
export type ReceivingSku = {
  readonly skuId: string;
  readonly code: string;
  readonly template: Template;
  /** CAT-017: pre-fills the expiry when only the manufacturing date is given. */
  readonly shelfLifeMonths: number | null;
};

export type ReceiptLineInput = {
  readonly packs: number;
  readonly lotNumber?: string | null | undefined;
  readonly manufacturedOn?: string | null | undefined;
  readonly expiresOn?: string | null | undefined;
  /** RCV-006: an alternative to the expiry date, applied to the manufacturing date. */
  readonly shelfLife?: { months: number } | { years: number } | null | undefined;
  readonly unitCost?: string | null | undefined;
};

export type ReceiptLine = {
  readonly skuId: string;
  readonly packs: number;
  readonly lotNumber: string | null;
  readonly manufacturedOn: string | null;
  readonly expiresOn: string | null;
  readonly unitCost: Money | null;
};

/**
 * RCV-003..008: one received line, checked against its product type's
 * template. Hidden attributes are dropped — a product type with expiry
 * disabled never gets an expiry date (CAT-016). Expiry comes from a date,
 * from a shelf-life period, or from the product's default shelf life.
 */
export function resolveReceiptLine(sku: ReceivingSku, input: ReceiptLineInput): ReceiptLine {
  if (!Number.isSafeInteger(input.packs) || input.packs <= 0) throw new DomainError('INVALID_PACK_COUNT', { value: input.packs, field: 'packs' });
  const t = sku.template;
  const keep = (mode: Template[keyof Template], value: string | null | undefined) => (mode === 'HIDDEN' ? null : value?.trim() || null);
  let expiresOn = keep(t.EXPIRY, input.expiresOn);
  const manufacturedOn = keep(t.MANUFACTURING_DATE, input.manufacturedOn);
  if (!expiresOn && t.EXPIRY !== 'HIDDEN' && manufacturedOn) {
    const period = input.shelfLife ?? (sku.shelfLifeMonths ? { months: sku.shelfLifeMonths } : null);
    if (period) expiresOn = expiryFromShelfLife(manufacturedOn, period);
  }
  const identity = batchIdentity({ lotNumber: keep(t.LOT_NUMBER, input.lotNumber), manufacturedOn, expiresOn });
  if (t.LOT_NUMBER === 'REQUIRED' && !identity.lotNumber) throw new DomainError('ATTRIBUTE_REQUIRED', { attribute: 'LOT_NUMBER', field: 'lotNumber' });
  if (t.MANUFACTURING_DATE === 'REQUIRED' && !identity.manufacturedOn) throw new DomainError('ATTRIBUTE_REQUIRED', { attribute: 'MANUFACTURING_DATE', field: 'manufacturedOn' });
  if (t.EXPIRY === 'REQUIRED' && !identity.expiresOn) throw new DomainError('EXPIRY_REQUIRED', { field: 'expiresOn' });
  let unitCost: Money | null = null;
  if (input.unitCost?.trim()) {
    try { unitCost = money(input.unitCost.trim()); } catch { throw new DomainError('INVALID_MONEY', { field: 'unitCost', value: input.unitCost }); }
  }
  return { skuId: sku.skuId, packs: input.packs, ...identity, unitCost };
}

/** The same rule for an imported row: every problem collected, none thrown (RCV-002). */
export function checkReceiptLine(sku: ReceivingSku, input: ReceiptLineInput): { line: ReceiptLine } | { error: { code: ErrorCode; field: string | null } } {
  try {
    return { line: resolveReceiptLine(sku, input) };
  } catch (e) {
    if (!isDomainError(e)) throw e;
    const field = typeof e.details.field === 'string' ? e.details.field : null;
    return { error: { code: e.code, field } };
  }
}
