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

export type DocumentLineAmounts = { readonly gross: Money; readonly discountAmount: Money; readonly total: Money };

/**
 * DOC-006: every figure the document prints, line by line and in total, so
 * they add up on the page: the totals are sums of the lines, the discount
 * before VAT is the difference between before and after it, and the grand
 * total is exactly what the sale came to.
 */
export function documentFigures(lines: readonly DocumentLineAmounts[], rate: Percent) {
  const split = lines.map((l) => ({ ...vatOf(l.total, rate), beforeDiscount: vatOf(l.gross, rate).taxable }));
  const sum = (values: readonly Money[]): Money => toMoney(values.reduce((t, v) => t.plus(dec(v)), new Dec(0)));
  const beforeDiscount = sum(split.map((s) => s.beforeDiscount));
  const taxable = sum(split.map((s) => s.taxable));
  return {
    lines: split.map(({ taxable: lineTaxable, vat }) => ({ taxable: lineTaxable, vat })),
    totals: {
      /** Total (excluding VAT), before discounts. */ beforeDiscount,
      /** Discounts, excluding VAT. */ discount: toMoney(dec(beforeDiscount).minus(dec(taxable))),
      /** Total taxable amount (excluding VAT). */ taxable,
      vat: sum(split.map((s) => s.vat)),
      /** Total including VAT — the sale's total. */ grand: sum(lines.map((l) => l.total)),
    },
  };
}

/**
 * DOC-010 (ADR-0053): what the QR code holds — the document's facts as plain
 * text. Deliberately not ZATCA's base64 TLV, so no tax app reads it as a tax
 * invoice; any phone shows it as written.
 */
export function documentQrText(d: {
  readonly seller: string; readonly title: string; readonly number: string; readonly issued: string;
  readonly total: Money; readonly vat: Money; readonly vatRate: Percent;
}): string {
  return [
    d.seller, `${d.title} ${d.number}`, d.issued,
    `Total incl. VAT: ${d.total} SAR`, `VAT ${dec(d.vatRate).toString()}%: ${d.vat} SAR`,
    'Not a tax invoice — ليست فاتورة ضريبية',
  ].join('\n');
}
