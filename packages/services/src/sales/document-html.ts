import { BRAND_MARK, sizeCode, type CountUnit, type CreditMode, type Money, type PackSize, type Percent } from '@gsa/core';

/**
 * The delivery document (DOC-001..010, ADR-0019, ADR-0053): Green Agro's own
 * invoice layout — header with the QR code, seller and buyer, the lines with
 * the VAT each price included, the totals in figures and words, the payment
 * terms — under our name for it, and marked on every page as an unofficial
 * delivery record, not a tax invoice (DOC-002). Bilingual, English and Arabic
 * side by side, printed to PDF by the worker. Like emails, its words are
 * built on the server; the interface's stay in the web app's message files.
 */
export type DocumentData = {
  /** ADR-0052: an open sale's paper is the simplified delivery record. */ readonly open: boolean;
  readonly number: string; readonly issuedAt: Date; readonly suppliedAt: Date;
  /** COR-006: a corrected copy — its version, and when the copy it replaces was issued. */
  readonly corrected: { readonly version: number; readonly replaces: Date } | null;
  /** DOC-007: the company, as the Admin entered it in Settings. */
  readonly seller: {
    readonly nameEn: string; readonly nameAr: string; readonly addressEn: string; readonly addressAr: string;
    readonly vatNumber: string; readonly otherId: string;
  };
  /** DOC-009: the store, or an open sale's buyer as far as they said; the Customer ID either way. */
  readonly buyer: {
    readonly code: string; readonly name: string | null; readonly contact: string | null; readonly phone: string | null;
    readonly address: string | null; readonly vatNumber: string | null;
  };
  readonly salesperson: string; readonly vehicle: string | null;
  readonly vatRate: Percent;
  readonly lines: readonly {
    readonly productEn: string; readonly productAr: string; readonly varietyEn: string | null; readonly varietyAr: string | null;
    readonly size: PackSize; readonly countUnit: CountUnit; readonly packs: number;
    /** Before VAT, to four decimals or more (DOC-006): unit price × packs − discount = taxable. */ readonly unitPrice: string;
    /** Before VAT. */ readonly discount: Money; readonly taxable: Money; readonly vat: Money;
    /** With VAT — what the store pays for the line. */ readonly total: Money;
  }[];
  readonly totals: {
    readonly beforeDiscount: Money; readonly discount: Money; readonly taxable: Money; readonly vat: Money; readonly grand: Money;
    readonly paid: Money; readonly due: Money;
  };
  readonly words: { readonly en: string; readonly ar: string };
  /** How it is to be paid: the store's credit terms, or paid in full there and then. */
  readonly terms: {
    readonly kind: CreditMode | 'PAID_IN_FULL'; readonly days: number | null; readonly dueOn: string | null;
    readonly method: 'CASH' | 'BANK_TRANSFER' | null;
  };
  /** DOC-010: the QR code's content, ZATCA's TLV in base64, and its SVG. */ readonly qr: string; readonly qrSvg: string;
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const amount = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (value: Money) => amount.format(value as `${number}`);
const unitAmount = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 8 });
const unitPrice = (value: string) => unitAmount.format(value as `${number}`);
const rateText = (value: Percent) => `${Number(value).toFixed(2)}%`;
// ADR-0026: Latin digits and the Gregorian calendar in both languages; Riyadh time.
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (at: Date) => dayFormat.format(at).replaceAll('-', '/');
const calendarDay = (iso: string) => iso.replaceAll('-', '/');

/** A Latin value inside Arabic keeps its own direction. */
const latin = (text: string) => `<bdi dir="ltr">${escape(text)}</bdi>`;
const ar = (text: string) => `<span dir="rtl" lang="ar">${escape(text)}</span>`;

/**
 * The sprout of the interface (lucide, ISC), beside the name in both
 * languages: the header's mark before Green Agro's logo, and still when the
 * logo is switched off or its file is missing (ADR-0057).
 */
const SPROUT = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#2d6a4f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
<path d="M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3"/><path d="M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4"/><path d="M5 21h14"/></svg>`;

/** A row of the header's table: English label, the value, Arabic label (the sample's three columns). */
const infoRow = (en: string, value: string, arLabel: string) =>
  `<tr><th class="en">${escape(en)}:</th><td class="val">${value}</td><th class="ar">${ar(`${arLabel}:`)}</th></tr>`;

/** A labelled line of a party box, English left and Arabic right. */
const partyRow = (en: string, value: string, arLabel: string) =>
  `<div class="prow"><span class="pl">${escape(en)}:</span><span class="pv">${value}</span><span class="pr">${ar(`${arLabel}:`)}</span></div>`;

/** A section title bar: English start, Arabic end. */
const bar = (en: string, arLabel: string) => `<div class="bar"><span>${escape(en)}:</span>${ar(`${arLabel}:`)}</div>`;

/** A column heading: Arabic above, English below, as in the sample. */
const head = (arLabel: string, en: string) => `<th><div class="h-ar">${ar(arLabel)}</div><div class="h-en">${escape(en)}</div></th>`;

function termsText(t: DocumentData['terms']): { en: string; ar: string } {
  switch (t.kind) {
    case 'PAID_IN_FULL': return { en: 'Paid in full', ar: 'مدفوع بالكامل' };
    case 'BILL_TO_BILL': return { en: 'Bill to bill', ar: 'فاتورة بفاتورة' };
    case 'WEEKLY': return { en: 'Credit (weekly)', ar: 'الائتمان (أسبوعي)' };
    case 'MONTHLY': return { en: 'Credit (monthly)', ar: 'الائتمان (شهري)' };
    case 'CUSTOM': return { en: `Credit (${t.days ?? 0} days)`, ar: `الائتمان (${t.days ?? 0} يومًا)` };
  }
}

function sellerBox(s: DocumentData['seller']): string {
  return `<div class="party">
  ${bar('SELLER', 'المورد')}
  <div class="pnames"><span class="pname">${escape(s.nameEn.toUpperCase())}</span><span class="pname">${ar(s.nameAr)}</span></div>
  ${s.addressEn || s.addressAr ? `<div class="paddr"><span>${escape(s.addressEn)}</span><span>${ar(s.addressAr)}</span></div>` : ''}
  ${partyRow('VAT Number', s.vatNumber ? latin(s.vatNumber) : '—', 'الرقم الضريبي')}
  ${partyRow('Other Seller ID', s.otherId ? latin(s.otherId) : '', 'معرف آخر')}
</div>`;
}

function buyerBox(b: DocumentData['buyer'], open: boolean): string {
  const name = b.name ?? (open ? 'Not given — لم يُذكر' : '');
  return `<div class="party">
  ${bar('BUYER', 'العميل')}
  <div class="pnames"><span class="pname">${escape(name)}</span>${b.contact ? `<span>${escape(b.contact)}</span>` : ''}</div>
  ${b.address || b.phone ? `<div class="paddr"><span>${b.address ? escape(b.address) : ''}</span><span>${b.phone ? latin(b.phone) : ''}</span></div>` : ''}
  ${partyRow('VAT Number', b.vatNumber ? latin(b.vatNumber) : '—', 'الرقم الضريبي')}
  ${partyRow('Customer ID', latin(b.code), 'رقم العميل')}
</div>`;
}

/** ADR-0057: Green Agro's logo — both names are in it — or, without it, the names beside the sprout. */
const brand = (logo: string | null | undefined) => (BRAND_MARK === 'LOGO' && logo && /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(logo)
  ? `<img class="logo-img" src="${logo}" alt="Green Skill Agro">`
  : `<div class="logo"><div class="names">${ar('غرين سكيل أغرو')}<br>Green Skill Agro</div>${SPROUT}</div>`);

export function deliveryDocumentHtml(data: DocumentData, opts: { readonly fontCss?: string; readonly logo?: string | null } = {}): string {
  const title = data.open ? { en: 'Simplified delivery record', ar: 'سند تسليم مبسّط' } : { en: 'Delivery document', ar: 'سند تسليم' };
  const terms = termsText(data.terms);
  const due = data.terms.dueOn ? latin(calendarDay(data.terms.dueOn)) : null;
  const rows = data.lines.map((l) => `<tr>
<td class="item"><div>${escape(l.productEn)}${l.varietyEn ? ` ${escape(l.varietyEn)}` : ''} - ${escape(sizeCode(l.size, l.countUnit))}</div><div class="item-ar">${ar(`${l.productAr}${l.varietyAr ? ` ${l.varietyAr}` : ''}`)}</div></td>
<td class="num">${unitPrice(l.unitPrice)}</td>
<td class="num">${l.packs}</td>
<td class="num">${money(l.taxable)}</td>
<td class="num">${money(l.discount)}</td>
<td class="num">${rateText(data.vatRate)}</td>
<td class="num">${money(l.vat)}</td>
<td class="num">${money(l.total)}</td>
</tr>`).join('\n');

  const totalRow = (en: string, small: string, arLabel: string, arSmall: string, value: Money) =>
    `<tr><th class="en">${escape(en)}${small ? ` <small>${escape(small)}</small>` : ''}</th><th class="ar">${ar(arLabel)}${arSmall ? ` <small>${ar(arSmall)}</small>` : ''}</th><td class="num">${money(value)} SAR</td></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(data.number)}</title>
<style>
${opts.fontCss ?? ''}
@page { size: A4; margin: 11mm 11mm 12mm;
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font-family: 'IBM Plex Sans Arabic', sans-serif; font-size: 8.5pt; color: #1c1917; } }
* { box-sizing: border-box; }
body { margin: 0; font-family: 'IBM Plex Sans Arabic', 'Noto Naskh Arabic', 'DejaVu Sans', sans-serif; font-size: 9pt; color: #1c1917; }
small { font-size: 6.5pt; font-weight: 400; }
.sheet { width: 100%; border-collapse: collapse; }
.sheet > thead > tr > td, .sheet > tbody > tr > td, .sheet > tfoot > tr > td { padding: 0; }
.top { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 8px; border-bottom: 2px solid #8a9a2b; }
.title-en { font-size: 17pt; font-weight: 700; color: #44403c; }
.title-ar { font-size: 15pt; font-weight: 700; color: #44403c; }
.logo { display: flex; align-items: center; gap: 6px; text-align: end; }
.logo .names { font-size: 8.5pt; font-weight: 700; color: #1b4332; line-height: 1.25; }
.logo-img { height: 21mm; width: auto; display: block; }
.meta { display: flex; align-items: center; gap: 12px; margin-top: 8px; padding-bottom: 6px; }
.info { flex: 1; border-collapse: collapse; }
.info th, .info td { padding: 3px 6px; border-bottom: 1px solid #c7d2fe; font-size: 8.5pt; }
.info th.en { text-align: start; font-weight: 700; color: #44403c; width: 32%; }
.info td.val { text-align: center; }
.info th.ar { text-align: end; font-weight: 700; color: #44403c; width: 30%; }
.qr svg { width: 29mm; height: 29mm; display: block; }
.notice { margin: 0 0 4px; padding: 4px 8px; border: 1.5px solid #b91c1c; color: #b91c1c; font-weight: 700; text-align: center; font-size: 8.5pt; }
.notice span { display: block; }
.corrected { margin: 6px 0 4px; padding: 4px 8px; border: 1.5px solid #92400e; color: #92400e; font-weight: 700; text-align: center; font-size: 8.5pt; }
.corrected span { display: block; }
.bar { display: flex; justify-content: space-between; background: #ededed; border-top: 2px solid #8a9a2b; padding: 3px 6px; font-weight: 700; font-size: 11pt; color: #1b4332; margin-top: 10px; }
.parties { display: flex; gap: 8px; }
.party { flex: 1; font-size: 8.5pt; }
.pnames, .paddr { display: flex; justify-content: space-between; gap: 8px; padding: 4px 2px 0; }
.pname { font-weight: 700; }
.paddr span { max-width: 50%; }
.prow { display: flex; padding: 3px 2px 0; }
.prow .pl { font-weight: 700; width: 34%; }
.prow .pv { flex: 1; text-align: center; }
.prow .pr { font-weight: 700; text-align: end; width: 30%; }
.lines { width: 100%; border-collapse: collapse; margin-top: 4px; }
.lines th { background: #ededed; padding: 4px 3px; font-size: 7.5pt; vertical-align: bottom; text-align: center; }
.lines .h-ar { font-weight: 700; } .lines .h-en { font-weight: 700; }
.lines td { padding: 3px 3px; border-bottom: 1px solid #c7d2fe; vertical-align: middle; font-size: 8.5pt; line-height: 1.3; }
.lines tbody tr, .summary, .prow { break-inside: avoid; }
.lines td.item { width: 30%; }
.item-ar { color: #44403c; }
.num { text-align: center; white-space: nowrap; }
.lines-end { border-bottom: 2px solid #8a9a2b; margin-top: 2px; }
.totals { display: flex; gap: 8px; margin-top: 4px; }
.totals table { flex: 1; border-collapse: collapse; }
.totals th, .totals td { padding: 3px 5px; border-bottom: 1px solid #c7d2fe; font-size: 8.5pt; }
.totals th.en { text-align: start; font-weight: 700; }
.totals th.ar { text-align: end; font-weight: 700; }
.totals td.num { text-align: end; width: 22%; }
.grand { width: 30mm; background: #ededed; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 14pt; font-weight: 700; color: #1b4332; }
.words { margin-top: 4px; text-align: center; font-size: 8.5pt; border-bottom: 1px solid #c7d2fe; padding: 3px 0; }
.words b { font-weight: 700; }
.foot-space { height: 40mm; }
.terms { position: fixed; bottom: 0; left: 0; right: 0; font-size: 8.5pt; }
.terms .bar { margin-top: 0; }
.terms .trow { display: flex; padding: 3px 4px; border-bottom: 1px solid #c7d2fe; }
.terms .trow:last-child { border-bottom: 1.5px solid #1c1917; }
.terms .tl { width: 28%; font-weight: 700; }
.terms .tv { flex: 1; }
.terms .tva { flex: 1; text-align: end; }
.terms .tboth { flex: 2; text-align: center; }
.terms .tr { width: 22%; font-weight: 700; text-align: end; }
</style></head>
<body>
<table class="sheet">
<thead><tr><td>
  <div class="top">
    <div><div class="title-en">${escape(title.en)}</div><div class="title-ar">${ar(title.ar)}</div></div>
    ${brand(opts.logo)}
  </div>
  <div class="meta">
    <table class="info">
      ${infoRow('Document Number', latin(data.corrected ? `${data.number} · v${data.corrected.version}` : data.number), 'رقم السند')}
      ${infoRow('Issue Date', latin(day(data.issuedAt)), 'تاريخ الإصدار')}
      ${infoRow('Date of Supply', latin(day(data.suppliedAt)), 'تاريخ التوريد')}
      ${infoRow('Sales Representative', `${escape(data.salesperson)}${data.vehicle ? ` · ${latin(data.vehicle)}` : ''}`, 'المندوب')}
    </table>
    <div class="qr" data-qr="${escape(data.qr)}">${data.qrSvg}</div>
  </div>
</td></tr></thead>
<tbody><tr><td>
  ${data.corrected ? `<div class="corrected" data-version="${data.corrected.version}"><span>Corrected — replaces the copy of ${escape(day(data.corrected.replaces))}.</span>${ar(`مُصحَّح — يحلّ محلّ النسخة الصادرة في ${day(data.corrected.replaces)}.`)}</div>` : ''}
  <div class="parties">${sellerBox(data.seller)}${buyerBox(data.buyer, data.open)}</div>

  ${bar('LINE ITEMS', 'توصيف السلعة أو الخدمة')}
  <table class="lines">
    <thead><tr>
      ${head('تفاصيل السلع أو الخدمات', 'Nature of goods or services')}
      ${head('سعر الوحدة', 'Unit Price')}
      ${head('الكمية', 'Quantity')}
      ${head('المبلغ الخاضع للضريبة', 'Taxable Amount')}
      ${head('خصومات', 'Discount')}
      ${head('نسبة الضريبة', 'Tax Rate')}
      ${head('مبلغ الضريبة', 'Tax Amount')}
      ${head('المجموع (شامل الضريبة)', 'Subtotal (with VAT)')}
    </tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <div class="lines-end"></div>

  <div class="summary">
  ${bar('TOTAL AMOUNT', 'إجمالي المبلغ')}
  <div class="totals">
    <table>
      ${totalRow('Total', '(Excluding VAT)', 'الإجمالي', '(غير شامل الضريبة)', data.totals.beforeDiscount)}
      ${totalRow('Discount', '', 'مجموع الخصومات', '', data.totals.discount)}
      ${totalRow('Total Taxable Amount', '(Excluding VAT)', 'الإجمالي الخاضع للضريبة', '(غير شامل الضريبة)', data.totals.taxable)}
      ${totalRow('Total VAT', '', 'مجموع ضريبة القيمة المضافة', '', data.totals.vat)}
      ${totalRow('Grand Total', '', 'الإجمالي شامل الضريبة', '', data.totals.grand)}
      ${totalRow('Total Paid', '', 'إجمالي المدفوع', '', data.totals.paid)}
      ${totalRow('Total Amount Due', '', 'إجمالي المبلغ المستحق', '', data.totals.due)}
    </table>
    <div class="grand">${money(data.totals.grand)}<br>SAR</div>
  </div>
  <div class="words">Total Amount in Words: <b>${escape(data.words.en)}.</b></div>
  <div class="words" dir="rtl" lang="ar">المبلغ الإجمالي كتابة: <b>${escape(data.words.ar)}</b></div>
  </div>
</td></tr></tbody>
<tfoot><tr><td><div class="foot-space"></div></td></tr></tfoot>
</table>

<div class="terms">
  <!-- DOC-002: on every page, as the payment terms are. -->
  <div class="notice"><span>This is not a tax invoice. It is an unofficial record of goods delivered.</span>${ar('هذه ليست فاتورة ضريبية، وإنما سجل غير رسمي بالبضاعة المسلّمة.')}</div>
  ${bar('PAYMENT TERMS', 'شروط الدفع')}
  <div class="trow"><span class="tl">Payment Type:</span><span class="tv">${escape(terms.en)}</span><span class="tva" dir="rtl" lang="ar">${escape(terms.ar)}</span><span class="tr">${ar('نوع الدفع:')}</span></div>
  ${due ? `<div class="trow"><span class="tl">Due Date:</span><span class="tboth">${due}</span><span class="tr">${ar('تاريخ الاستحقاق:')}</span></div>` : ''}
  <div class="trow"><span class="tl">Accepted Payment Methods:</span><span class="tv">Bank Transfer, Cash</span><span class="tva" dir="rtl" lang="ar">تحويل بنكي، نقدًا</span><span class="tr">${ar('طرق الدفع المقبولة:')}</span></div>
</div>
</body></html>`;
}
