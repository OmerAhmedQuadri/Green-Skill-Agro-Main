import { BRAND_MARK, type CreditMode, type Money } from '@gsa/core';

/**
 * The store statement (IMP-010, ADR-0059): a store's account as it stood on its day — every entry, imported from
 * Green Agro's books or made in the app, each labelled, with a correction shown beside what it replaced — in Green
 * Agro's document style (ADR-0053). Bilingual, English and Arabic side by side, printed to PDF by the worker. Like the
 * delivery document's, its words are built on the server.
 */
export type StatementData = {
  readonly number: string; readonly asOf: Date;
  readonly company: { readonly nameEn: string; readonly nameAr: string; readonly addressEn: string; readonly addressAr: string; readonly vatNumber: string };
  readonly store: {
    readonly code: string; readonly name: string; readonly owner: string | null; readonly phone: string | null; readonly address: string | null;
    readonly seller: string | null; readonly mode: CreditMode | null; readonly days: number | null; readonly limit: Money;
  };
  readonly entries: readonly StatementEntry[];
  readonly totals: {
    readonly billed: Money; readonly paid: Money; readonly returned: Money; readonly adjusted: Money; readonly balance: Money; readonly pastDue: Money;
  };
};

export type StatementEntry = {
  readonly at: Date; readonly dueOn: string | null;
  readonly debit: Money | null; readonly credit: Money | null; readonly balance: Money;
  /** What the entry is, in both languages, and its number, voucher or note (Latin). */
  readonly what: { readonly en: string; readonly ar: string }; readonly detail: string | null;
  /** IMP-003: where an imported entry was written. */
  readonly imported: string | null;
  /** COR-002: a correction made, or replaced, this entry. */
  readonly correction: { readonly en: string; readonly ar: string } | null;
  /** Replaced by a correction, or the reversal of one: shown, but no longer standing. */
  readonly replaced: boolean;
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const amount = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (value: Money) => amount.format(value as `${number}`);
// ADR-0026: Latin digits and the Gregorian calendar in both languages; Riyadh time.
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const day = (at: Date) => dayFormat.format(at).replaceAll('-', '/');
const calendarDay = (iso: string) => iso.replaceAll('-', '/');
const latin = (text: string) => `<bdi dir="ltr">${escape(text)}</bdi>`;
const ar = (text: string) => `<span dir="rtl" lang="ar">${escape(text)}</span>`;

const infoRow = (en: string, value: string, arLabel: string) =>
  `<tr><th class="en">${escape(en)}:</th><td class="val">${value}</td><th class="ar">${ar(`${arLabel}:`)}</th></tr>`;
const bar = (en: string, arLabel: string) => `<div class="bar"><span>${escape(en)}:</span>${ar(`${arLabel}:`)}</div>`;
const head = (arLabel: string, en: string) => `<th><div>${ar(arLabel)}</div><div>${escape(en)}</div></th>`;

function termsText(mode: CreditMode | null, days: number | null): { en: string; ar: string } {
  switch (mode) {
    case null: return { en: '—', ar: '—' };
    case 'BILL_TO_BILL': return { en: 'Bill to bill', ar: 'فاتورة بفاتورة' };
    case 'WEEKLY': return { en: 'Credit (weekly)', ar: 'الائتمان (أسبوعي)' };
    case 'MONTHLY': return { en: 'Credit (monthly)', ar: 'الائتمان (شهري)' };
    case 'CUSTOM': return { en: `Credit (${days ?? 0} days)`, ar: `الائتمان (${days ?? 0} يومًا)` };
  }
}

const brand = (logo: string | null | undefined, data: StatementData) => (BRAND_MARK === 'LOGO' && logo && /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(logo)
  ? `<img class="logo-img" src="${logo}" alt="${escape(data.company.nameEn)}">`
  : `<div class="names">${ar(data.company.nameAr)}<br>${escape(data.company.nameEn)}</div>`);

export function storeStatementHtml(data: StatementData, opts: { readonly fontCss?: string; readonly logo?: string | null } = {}): string {
  const terms = termsText(data.store.mode, data.store.days);
  const rows = data.entries.map((e) => `<tr class="${e.replaced ? 'replaced' : ''}">
<td class="num">${latin(day(e.at))}</td>
<td class="what">
  <div><b>${escape(e.what.en)}</b>${e.detail ? ` · ${latin(e.detail)}` : ''}</div>
  <div class="what-ar">${ar(e.what.ar)}</div>
  ${e.imported !== null ? `<div class="tag">Imported · ${ar('منقول من الدفاتر')}${e.imported ? ` — ${latin(e.imported)}` : ''}</div>` : ''}
  ${e.correction ? `<div class="tag corr">${escape(e.correction.en)} · ${ar(e.correction.ar)}</div>` : ''}
</td>
<td class="num">${e.dueOn ? latin(calendarDay(e.dueOn)) : ''}</td>
<td class="num amount">${e.debit ? money(e.debit) : ''}</td>
<td class="num amount">${e.credit ? money(e.credit) : ''}</td>
<td class="num">${money(e.balance)}</td>
</tr>`).join('\n');
  const totalRow = (en: string, arLabel: string, value: Money) =>
    `<tr><th class="en">${escape(en)}</th><th class="ar">${ar(arLabel)}</th><td class="num">${money(value)} SAR</td></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(data.number)}</title>
<style>
${opts.fontCss ?? ''}
@page { size: A4; margin: 11mm 11mm 12mm;
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font-family: 'IBM Plex Sans Arabic', sans-serif; font-size: 8.5pt; color: #1c1917; } }
* { box-sizing: border-box; }
body { margin: 0; font-family: 'IBM Plex Sans Arabic', 'Noto Naskh Arabic', 'DejaVu Sans', sans-serif; font-size: 9pt; color: #1c1917; }
.top { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 8px; border-bottom: 2px solid #8a9a2b; }
.title-en { font-size: 17pt; font-weight: 700; color: #44403c; }
.title-ar { font-size: 15pt; font-weight: 700; color: #44403c; }
.names { font-size: 8.5pt; font-weight: 700; color: #1b4332; line-height: 1.25; text-align: end; }
.logo-img { height: 21mm; width: auto; display: block; }
.info { width: 100%; border-collapse: collapse; margin-top: 8px; }
.info th, .info td { padding: 3px 6px; border-bottom: 1px solid #c7d2fe; font-size: 8.5pt; }
.info th.en { text-align: start; font-weight: 700; color: #44403c; width: 30%; }
.info td.val { text-align: center; }
.info th.ar { text-align: end; font-weight: 700; color: #44403c; width: 30%; }
.bar { display: flex; justify-content: space-between; background: #ededed; border-top: 2px solid #8a9a2b; padding: 3px 6px; font-weight: 700; font-size: 11pt; color: #1b4332; margin-top: 10px; }
.entries { width: 100%; border-collapse: collapse; margin-top: 4px; }
.entries th { background: #ededed; padding: 4px 3px; font-size: 7.5pt; font-weight: 700; text-align: center; vertical-align: bottom; }
.entries td { padding: 3px; border-bottom: 1px solid #c7d2fe; font-size: 8.5pt; vertical-align: top; line-height: 1.3; }
.entries tr { break-inside: avoid; }
.entries td.what { width: 42%; }
.what-ar { color: #44403c; }
.tag { font-size: 7.5pt; color: #57534e; }
.tag.corr { color: #92400e; }
.replaced td { color: #a8a29e; }
/* What a correction replaced no longer counts; the running balance beside it was true at the time. */
.replaced td.amount { text-decoration: line-through; }
.num { text-align: center; white-space: nowrap; }
.totals { display: flex; gap: 8px; margin-top: 4px; break-inside: avoid; }
.totals table { flex: 1; border-collapse: collapse; }
.totals th, .totals td { padding: 3px 5px; border-bottom: 1px solid #c7d2fe; font-size: 8.5pt; }
.totals th.en { text-align: start; } .totals th.ar { text-align: end; }
.totals td.num { text-align: end; width: 26%; }
.grand { width: 34mm; background: #ededed; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; font-size: 13pt; font-weight: 700; color: #1b4332; }
.grand small { font-size: 7.5pt; font-weight: 400; }
.note { margin-top: 10px; padding: 4px 8px; border: 1.5px solid #8a9a2b; font-size: 8pt; text-align: center; }
.note span { display: block; }
</style></head>
<body>
  <div class="top">
    <div><div class="title-en">Statement of account</div><div class="title-ar">${ar('كشف حساب')}</div></div>
    ${brand(opts.logo, data)}
  </div>
  <table class="info">
    ${infoRow('Statement Number', latin(data.number), 'رقم الكشف')}
    ${infoRow('As of', latin(`${day(data.asOf)} ${timeFormat.format(data.asOf)}`), 'حتى تاريخ')}
    ${infoRow('Customer ID', latin(data.store.code), 'رقم العميل')}
    ${infoRow('Store', escape(data.store.name), 'المتجر')}
    ${infoRow('Owner', data.store.owner ? escape(data.store.owner) : '—', 'المالك')}
    ${infoRow('Phone', data.store.phone ? latin(data.store.phone) : '—', 'الهاتف')}
    ${infoRow('Sales Representative', data.store.seller ? escape(data.store.seller) : '—', 'المندوب')}
    ${infoRow('Credit Terms', `${escape(terms.en)} · ${ar(terms.ar)}`, 'شروط الائتمان')}
    ${infoRow('Credit Limit', `${money(data.store.limit)} SAR`, 'حد الائتمان')}
  </table>

  ${bar('ACCOUNT ENTRIES', 'قيود الحساب')}
  <table class="entries">
    <thead><tr>
      ${head('التاريخ', 'Date')}
      ${head('البيان', 'Entry')}
      ${head('الاستحقاق', 'Due')}
      ${head('مدين', 'Debit')}
      ${head('دائن', 'Credit')}
      ${head('الرصيد', 'Balance')}
    </tr></thead>
    <tbody>
${rows || `<tr><td colspan="6" class="num">No entries · ${ar('لا قيود')}</td></tr>`}
    </tbody>
  </table>

  ${bar('SUMMARY', 'الملخص')}
  <div class="totals">
    <table>
      ${totalRow('Total billed', 'إجمالي الفواتير', data.totals.billed)}
      ${totalRow('Total paid', 'إجمالي المدفوع', data.totals.paid)}
      ${totalRow('Returns', 'المرتجعات', data.totals.returned)}
      ${totalRow('Adjustments', 'التسويات', data.totals.adjusted)}
      ${totalRow('Balance', 'الرصيد', data.totals.balance)}
      ${totalRow('Of which past due', 'منه متأخر', data.totals.pastDue)}
    </table>
    <div class="grand">${money(data.totals.balance)}<small>SAR · ${ar('ريال')}</small></div>
  </div>
  <div class="note">
    <span>The account as recorded on ${escape(day(data.asOf))}. Entries marked Imported come from Green Agro's books before the app; a correction is shown beside the entry it replaced, which no longer counts.</span>
    ${ar(`الحساب كما هو مسجّل في ${day(data.asOf)}. القيود المعلَّمة «منقول من الدفاتر» من دفاتر غرين أغرو قبل التطبيق؛ ويظهر التصحيح بجانب القيد الذي استبدله، والذي لم يعد يُحتسب.`)}
  </div>
</body></html>`;
}
