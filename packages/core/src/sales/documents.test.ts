import { describe, expect, it } from 'vitest';
import type { Money, Percent } from '../numeric';
import { customerCode } from '../stores';
import { parseSetting } from '../system';
import { documentFigures, documentQr, vatOf } from './documents';
import { amountInWords } from './words';

const m = (v: string) => v as Money;
const p = (v: string) => v as Percent;

describe('the delivery document (ADR-0053)', () => {
  it('DOC-006: prices include VAT — a line\'s VAT is what its total contains, and the two add back to the total', () => {
    expect(vatOf(m('379.50'), p('15'))).toEqual({ taxable: '330.00', vat: '49.50' });
    expect(vatOf(m('90.00'), p('15'))).toEqual({ taxable: '78.26', vat: '11.74' });
    expect(vatOf(m('100.00'), p('0'))).toEqual({ taxable: '100.00', vat: '0.00' });
  });

  it('DOC-006: a line reads as the sample\'s — unit price × quantity − discount is the taxable amount, plus the VAT the total the store pays', () => {
    // 17.25 including VAT is the sample's 15.00 before it.
    expect(documentFigures([{ unitPrice: m('17.25'), packs: 22, gross: m('379.50'), total: m('379.50') }], p('15')).lines)
      .toEqual([{ unitPrice: '15.0000', discount: '0.00', taxable: '330.00', vat: '49.50' }]);
    // 90.00 is 78.2609 before VAT; two less 5% is 171.00, of which 22.30 is VAT — and 78.2609 × 2 − 7.82 = 148.70.
    const d = documentFigures([{ unitPrice: m('90.00'), packs: 2, gross: m('180.00'), total: m('171.00') }], p('15'));
    expect(d.lines).toEqual([{ unitPrice: '78.2609', discount: '7.82', taxable: '148.70', vat: '22.30' }]);
    expect(d.totals).toEqual({ beforeDiscount: '156.52', discount: '7.82', taxable: '148.70', vat: '22.30', grand: '171.00' });
    // A thousand at 15.00: four decimals (13.0435 × 1000 = 13043.50) would miss 13043.48 — so five.
    expect(documentFigures([{ unitPrice: m('15.00'), packs: 1000, gross: m('15000.00'), total: m('15000.00') }], p('15')).lines[0]?.unitPrice).toBe('13.04348');
  });

  it('DOC-006: the totals are the lines\' sums, and the grand total is the sale\'s total', () => {
    // The sample's nine lines, at their totals including VAT.
    const totals = ['379.50', '258.75', '86.25', '200.10', '300.15', '300.15', '345.00', '172.50', '362.25'];
    const f = documentFigures(totals.map((t) => ({ unitPrice: m(t), packs: 1, gross: m(t), total: m(t) })), p('15'));
    expect(f.totals).toEqual({ beforeDiscount: '2091.00', discount: '0.00', taxable: '2091.00', vat: '313.65', grand: '2404.65' });
  });

  it('DOC-008: the amount in words, in English and Arabic, the nouns agreeing with their numbers', () => {
    expect(amountInWords(m('2404.65'), 'en')).toBe('TWO THOUSAND FOUR HUNDRED AND FOUR SAUDI RIYALS AND SIXTY-FIVE HALALAS');
    expect(amountInWords(m('2404.65'), 'ar')).toBe('فقط ألفان وأربعمائة وأربعة ريالات سعودية وخمس وستون هللة لا غير');
    expect(amountInWords(m('1.00'), 'en')).toBe('ONE SAUDI RIYAL');
    expect(amountInWords(m('1.00'), 'ar')).toBe('فقط ريال سعودي واحد لا غير');
    expect(amountInWords(m('2.01'), 'ar')).toBe('فقط ريالان سعوديان وهللة واحدة لا غير');
    expect(amountInWords(m('0.50'), 'en')).toBe('FIFTY HALALAS');
    expect(amountInWords(m('0.50'), 'ar')).toBe('فقط خمسون هللة لا غير');
    expect(amountInWords(m('15.00'), 'ar')).toBe('فقط خمسة عشر ريالًا سعوديًا لا غير');
    expect(amountInWords(m('100.00'), 'ar')).toBe('فقط مائة ريال سعودي لا غير');
    expect(amountInWords(m('2004.00'), 'en')).toBe('TWO THOUSAND AND FOUR SAUDI RIYALS');
    expect(amountInWords(m('15000.00'), 'ar')).toBe('فقط خمسة عشر ألف ريال سعودي لا غير');
    expect(amountInWords(m('15500.00'), 'ar')).toBe('فقط خمسة عشر ألفًا وخمسمائة ريال سعودي لا غير');
    expect(amountInWords(m('200000.00'), 'ar')).toBe('فقط مائتا ألف ريال سعودي لا غير');
    expect(amountInWords(m('345678.28'), 'ar')).toBe('فقط ثلاثمائة وخمسة وأربعون ألفًا وستمائة وثمانية وسبعون ريالًا سعوديًا وثمان وعشرون هللة لا غير');
    expect(amountInWords(m('3000000.00'), 'en')).toBe('THREE MILLION SAUDI RIYALS');
    expect(amountInWords(m('3000000.00'), 'ar')).toBe('فقط ثلاثة ملايين ريال سعودي لا غير');
  });

  it('DOC-009: stores and open-sale buyers are numbered apart', () => {
    expect(customerCode('STORE', 1)).toBe('GSA-S-0001');
    expect(customerCode('BUYER', 2610)).toBe('GSA-C-2610');
    expect(customerCode('STORE', 12345)).toBe('GSA-S-12345');
  });

  it('DOC-010: the QR is ZATCA\'s — seller, VAT number, time, total and VAT as tag, length and value, in base64', () => {
    // ZATCA's own published example.
    expect(documentQr({ seller: 'Bobs Records', vatNumber: '310122393500003', issuedAt: '2022-04-25T15:30:00Z', total: m('1000.00'), vat: m('150.00') }))
      .toBe('AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==');
    // An Arabic name counts its bytes, not its letters; one too long for a length byte is cut at a letter's end.
    const fields = (qr: string) => {
      const bytes = Uint8Array.from(atob(qr), (c) => c.charCodeAt(0));
      const out: string[] = [];
      for (let i = 0; i < bytes.length; i += 2 + (bytes[i + 1] ?? 0)) out.push(new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(i + 2, i + 2 + (bytes[i + 1] ?? 0))));
      return out;
    };
    expect(fields(documentQr({ seller: 'شركة مثال', vatNumber: '', issuedAt: '2026-10-12T14:05:00', total: m('2404.65'), vat: m('313.65') })))
      .toEqual(['شركة مثال', '', '2026-10-12T14:05:00', '2404.65', '313.65']);
    const long = fields(documentQr({ seller: 'م'.repeat(200), vatNumber: '300000000000003', issuedAt: '2026-10-12T14:05:00', total: m('1.00'), vat: m('0.13') }));
    expect(long[0]).toBe('م'.repeat(127));
    expect(long.slice(1)).toEqual(['300000000000003', '2026-10-12T14:05:00', '1.00', '0.13']);
  });

  it('DOC-007: the company\'s details are text the Admin enters; a VAT number must look like one', () => {
    expect(parseSetting('company.name_en', '  Green Skill Agro Company ')).toBe('Green Skill Agro Company');
    expect(parseSetting('company.vat_number', '')).toBe('');
    expect(parseSetting('company.vat_number', '300000000000003')).toBe('300000000000003');
    expect(() => parseSetting('company.vat_number', '12345')).toThrow();
    expect(() => parseSetting('company.name_en', 'x'.repeat(121))).toThrow();
    expect(parseSetting('vat.rate', '15')).toBe('15');
  });
});
