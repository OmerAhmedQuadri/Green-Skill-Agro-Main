import { Dec, dec, toMoney, type Money, type Percent } from '../numeric';

/**
 * The delivery document (DOC-001..010, ADR-0019, ADR-0037, ADR-0053): an unofficial
 * delivery record, never a tax invoice. Its row is the render job.
 */
export const DELIVERY_DOCUMENT_STATUSES = ['PENDING', 'READY', 'FAILED'] as const;
export type DeliveryDocumentStatus = (typeof DELIVERY_DOCUMENT_STATUSES)[number];

/** DOC-004: whether the seller must send it, may, or cannot. A copy is kept in every case (DOC-005). */
export const DOCUMENT_SENDING_MODES = ['OPTIONAL', 'COMPULSORY', 'DISABLED'] as const;
export type DocumentSendingMode = (typeof DOCUMENT_SENDING_MODES)[number];

/** DOC-003, OQ-007: the phone's share sheet (WhatsApp, SMS, …) or email from the server. */
export const DOCUMENT_SEND_CHANNELS = ['SHARE', 'EMAIL'] as const;
export type DocumentSendChannel = (typeof DOCUMENT_SEND_CHANNELS)[number];

/** Attempts before a render is given up as FAILED; each waits longer than the last. */
export const DOCUMENT_RENDER_MAX_ATTEMPTS = 6;
export const documentRenderBackoffMs = (attempt: number): number => Math.min(30 * 60_000, 15_000 * 2 ** (attempt - 1));

/**
 * ADR-0053 (DOC-006): prices include VAT, so a line's VAT is what its total
 * contains — total × rate / (100 + rate) — and its taxable amount the rest.
 * Each line rounds once, to the halala; taxable + VAT is always the total.
 */
export function vatOf(totalIncl: Money, rate: Percent): { readonly taxable: Money; readonly vat: Money } {
  const taxable = toMoney(dec(totalIncl).times(100).div(dec(rate).plus(100)));
  return { taxable, vat: toMoney(dec(totalIncl).minus(dec(taxable))) };
}

/** A sale line's own figures: its price and quantity, and its totals before and after discount — all including VAT. */
export type DocumentLineAmounts = { readonly unitPrice: Money; readonly packs: number; readonly gross: Money; readonly total: Money };

/**
 * DOC-006: every figure the document prints, line by line and in total, as
 * Green Agro's own invoices show them: the unit price and the discount before
 * VAT, so that unit price × quantity − discount is the taxable amount, and
 * taxable amount + VAT is the line's total — which is what the store pays,
 * exactly. The totals are the lines' sums.
 */
export function documentFigures(lines: readonly DocumentLineAmounts[], rate: Percent) {
  const split = lines.map((l) => {
    const { taxable, vat } = vatOf(l.total, rate);
    const gross = vatOf(l.gross, rate).taxable;
    return { unitPrice: unitPriceBeforeVat(l.unitPrice, l.packs, gross, rate), gross, discount: toMoney(dec(gross).minus(dec(taxable))), taxable, vat };
  });
  const sum = (values: readonly Money[]): Money => toMoney(values.reduce((t, v) => t.plus(dec(v)), new Dec(0)));
  return {
    lines: split.map(({ unitPrice, discount, taxable, vat }) => ({ unitPrice, discount, taxable, vat })),
    totals: {
      /** Total (excluding VAT), before discounts. */ beforeDiscount: sum(split.map((s) => s.gross)),
      /** Discounts, excluding VAT. */ discount: sum(split.map((s) => s.discount)),
      /** Total taxable amount (excluding VAT). */ taxable: sum(split.map((s) => s.taxable)),
      vat: sum(split.map((s) => s.vat)),
      /** Total including VAT — the sale's total. */ grand: sum(lines.map((l) => l.total)),
    },
  };
}

/**
 * The unit price before VAT, to four decimals — or as many more as a large
 * quantity needs for price × quantity to come to the line's amount before
 * VAT, to the halala.
 */
function unitPriceBeforeVat(unitPrice: Money, packs: number, grossBeforeVat: Money, rate: Percent): string {
  const exact = dec(unitPrice).times(100).div(dec(rate).plus(100));
  for (let places = 4; places < 8; places += 1) {
    const shown = exact.toDecimalPlaces(places);
    if (toMoney(shown.times(packs)) === grossBeforeVat) return shown.toFixed(places);
  }
  return exact.toFixed(8);
}

/**
 * DOC-010 (ADR-0053): the QR code as ZATCA's e-invoices carry it, and Green
 * Agro's own invoices with them — the seller's name, the VAT number, the time
 * of issue, the total with VAT and the VAT, each as tag, length and UTF-8
 * value (TLV), in base64.
 */
export function documentQr(d: {
  readonly seller: string; readonly vatNumber: string; /** Riyadh time, `YYYY-MM-DDTHH:mm:ss`. */ readonly issuedAt: string;
  readonly total: Money; readonly vat: Money;
}): string {
  const bytes = [d.seller, d.vatNumber, d.issuedAt, d.total, d.vat].flatMap((value, i) => {
    const encoded = tlvValue(value);
    return [i + 1, encoded.length, ...encoded];
  });
  return btoa(String.fromCharCode(...bytes));
}

/** A value's UTF-8 bytes — cut at a character's end should it pass the 255 that one length byte can say. */
function tlvValue(value: string): Uint8Array {
  const encoder = new TextEncoder();
  let chars = [...value];
  let encoded = encoder.encode(value);
  while (encoded.length > 255) {
    chars = chars.slice(0, -1);
    encoded = encoder.encode(chars.join(''));
  }
  return encoded;
}
