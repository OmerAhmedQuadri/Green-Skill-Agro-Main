import { sizeCode, type CountUnit, type Money, type PackSize, type Percent } from '@gsa/core';

/**
 * The delivery document (DOC-001, DOC-002, DOC-006, OQ-011, ADR-0019): one
 * bilingual page, English and Arabic side by side, printed to PDF by the
 * worker. Like emails, it is text built on the server; the interface's words
 * stay in the web app's message files. No VAT anywhere — no line, no note,
 * not the store's VAT number (OQ-008).
 */
export type DocumentData = {
  readonly number: string; readonly issuedAt: Date;
  readonly store: { readonly name: string; readonly ownerName: string; readonly contactNumber: string };
  readonly seller: string; readonly vehicle: string;
  readonly lines: readonly {
    readonly code: string; readonly productEn: string; readonly productAr: string; readonly varietyEn: string | null; readonly varietyAr: string | null;
    readonly size: PackSize; readonly countUnit: CountUnit; readonly packs: number; readonly unitPrice: Money; readonly discount: Percent;
    readonly discountAmount: Money; readonly total: Money;
  }[];
  readonly gross: Money; readonly discount: Money; readonly total: Money;
  /** SAL-006: settled at the sale, or owed by the store's cycle. */
  readonly settlement: { readonly kind: 'PAID'; readonly method: 'CASH' | 'BANK_TRANSFER'; readonly reference: string | null } | { readonly kind: 'ON_ACCOUNT'; readonly dueOn: string };
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const amount = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (value: Money) => amount.format(value as `${number}`);
const percentText = (value: Percent) => `${value.includes('.') ? value.replace(/\.?0+$/, '') : value}%`;
// ADR-0026: Latin digits and the Gregorian calendar in both languages; Riyadh time.
const issued = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' });
const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium' });
const dateOnly = (iso: string) => day.format(new Date(`${iso}T00:00:00Z`));

/**
 * A label in both languages, English then Arabic. The separator sits outside
 * the right-to-left run, and Latin inside Arabic (a date, a reference) is
 * isolated, so neither is reordered by the bidi algorithm.
 */
const bothHtml = (en: string, ar: string) => `<span class="en">${en}</span><span class="sep"> · </span><bdi class="ar" dir="rtl" lang="ar">${ar}</bdi>`;
const both = (en: string, ar: string) => bothHtml(escape(en), escape(ar));
const latin = (text: string) => `<bdi dir="ltr">${escape(text)}</bdi>`;

function settlementText(s: DocumentData['settlement']): string {
  if (s.kind === 'ON_ACCOUNT') return bothHtml(`On account — due ${latin(dateOnly(s.dueOn))}`, `على الحساب — يستحق في ${latin(dateOnly(s.dueOn))}`);
  const ref = s.reference ? ` (${latin(s.reference)})` : '';
  return s.method === 'CASH'
    ? both('Paid in full — cash', 'مدفوع بالكامل — نقدًا')
    : bothHtml(`Paid in full — bank transfer${ref}`, `مدفوع بالكامل — تحويل بنكي${ref}`);
}

export function deliveryDocumentHtml(data: DocumentData, opts: { readonly fontCss?: string } = {}): string {
  const rows = data.lines.map((l, i) => `<tr>
<td class="num">${i + 1}</td>
<td><div>${escape(l.productEn)}${l.varietyEn ? ` — ${escape(l.varietyEn)}` : ''}</div><div dir="rtl" lang="ar" class="ar-line">${escape(l.productAr)}${l.varietyAr ? ` — ${escape(l.varietyAr)}` : ''}</div><div class="code">${escape(l.code)} · ${escape(sizeCode(l.size, l.countUnit))}</div></td>
<td class="num">${l.packs}</td>
<td class="num">${money(l.unitPrice)}</td>
<td class="num">${l.discountAmount === '0.00' ? '—' : `${percentText(l.discount)}<div class="code">−${money(l.discountAmount)}</div>`}</td>
<td class="num">${money(l.total)}</td>
</tr>`).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(data.number)}</title>
<style>
${opts.fontCss ?? ''}
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: 'IBM Plex Sans Arabic', 'Noto Naskh Arabic', 'DejaVu Sans', sans-serif; font-size: 11pt; color: #1c1917; }
.sep { color: #a8a29e; }
header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1b4332; padding-bottom: 8px; }
.brand { font-size: 18pt; font-weight: 700; color: #1b4332; }
.title { font-size: 13pt; font-weight: 600; margin-top: 2px; }
.meta { text-align: right; font-size: 10pt; }
.meta .number { font-size: 13pt; font-weight: 700; }
.notice { margin: 10px 0; padding: 8px 10px; border: 2px solid #b91c1c; color: #b91c1c; font-weight: 700; text-align: center; font-size: 11.5pt; }
.notice .ar { display: block; margin-top: 4px; }
.notice .sep, th .sep { display: none; }
.parties { display: flex; gap: 16px; margin: 10px 0; font-size: 10pt; }
.parties > div { flex: 1; border: 1px solid #e7e5e4; border-radius: 4px; padding: 8px; }
.parties h2 { font-size: 9pt; text-transform: uppercase; color: #78716c; margin: 0 0 4px; font-weight: 600; }
.parties .name { font-size: 11.5pt; font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 10pt; }
th { background: #f5f5f4; text-align: left; padding: 6px; border-bottom: 1px solid #d6d3d1; font-weight: 600; vertical-align: bottom; }
th.num { text-align: right; }
th .ar { display: block; text-align: inherit; font-weight: 500; }
td { padding: 6px; border-bottom: 1px solid #e7e5e4; vertical-align: top; }
.num { text-align: right; white-space: nowrap; }
.code { color: #78716c; font-size: 8.5pt; }
.ar-line { color: #44403c; text-align: left; }
.totals { margin-top: 8px; margin-inline-start: auto; width: 55%; font-size: 10.5pt; }
.totals td { border: none; padding: 3px 6px; }
.totals .grand td { border-top: 2px solid #1c1917; font-size: 12.5pt; font-weight: 700; padding-top: 6px; }
.settlement { margin-top: 10px; font-weight: 600; }
</style></head>
<body>
<header>
  <div><div class="brand">${bothHtml('Green Agro', 'غرين أغرو')}</div><div class="title">${both('Delivery document', 'سند تسليم')}</div></div>
  <div class="meta"><div class="number">${escape(data.number)}</div><div>${escape(issued.format(data.issuedAt))}</div></div>
</header>
<div class="notice">${both('This is not a tax invoice. It is an unofficial record of goods delivered.', 'هذه ليست فاتورة ضريبية، وإنما سجل غير رسمي بالبضاعة المسلّمة.')}</div>
<section class="parties">
  <div><h2>${both('Store', 'المتجر')}</h2><div class="name">${escape(data.store.name)}</div><div>${escape(data.store.ownerName)}</div><div><bdi dir="ltr">${escape(data.store.contactNumber)}</bdi></div></div>
  <div><h2>${both('Seller', 'المندوب')}</h2><div class="name">${escape(data.seller)}</div><div>${both('Vehicle', 'المركبة')} <bdi>${escape(data.vehicle)}</bdi></div></div>
</section>
<table>
<thead><tr>
<th class="num">#</th><th>${both('Item', 'الصنف')}</th><th class="num">${both('Packs', 'العبوات')}</th><th class="num">${both('Unit price', 'سعر الوحدة')}</th>
<th class="num">${both('Discount', 'الخصم')}</th><th class="num">${both('Amount', 'المبلغ')}</th>
</tr></thead>
<tbody>
${rows}
</tbody>
</table>
<table class="totals">
<tr><td>${both('Subtotal', 'المجموع')}</td><td class="num">${money(data.gross)}</td></tr>
<tr><td>${both('Discount', 'الخصم')}</td><td class="num">${data.discount === '0.00' ? '—' : `−${money(data.discount)}`}</td></tr>
<tr class="grand"><td>${both('Total (SAR)', 'الإجمالي (ر.س)')}</td><td class="num">${money(data.total)}</td></tr>
</table>
<div class="settlement">${settlementText(data.settlement)}</div>
</body></html>`;
}
