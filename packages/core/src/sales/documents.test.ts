import { describe, expect, it } from 'vitest';
import type { Money, Percent } from '../numeric';
import { customerCode } from '../stores';
import { parseSetting } from '../system';
import { documentFigures, documentQrText, vatOf } from './documents';
import { amountInWords } from './words';

const m = (v: string) => v as Money;
const p = (v: string) => v as Percent;

describe('the delivery document (ADR-0053)', () => {
  it('DOC-006: prices include VAT — a line\'s VAT is what its total contains, and the two add back to the total', () => {
    expect(vatOf(m('379.50'), p('15'))).toEqual({ taxable: '330.00', vat: '49.50' });
    expect(vatOf(m('90.00'), p('15'))).toEqual({ taxable: '78.26', vat: '11.74' });
    expect(vatOf(m('100.00'), p('0'))).toEqual({ taxable: '100.00', vat: '0.00' });
  });

  it('DOC-006: the totals are the lines\' sums, and the grand total is the sale\'s total', () => {
    // The sample's nine lines, at the prices including VAT.
    const totals = ['379.50', '258.75', '86.25', '200.10', '300.15', '300.15', '345.00', '172.50', '362.25'];
    const f = documentFigures(totals.map((t) => ({ gross: m(t), discountAmount: m('0.00'), total: m(t) })), p('15'));
    expect(f.totals).toEqual({ beforeDiscount: '2091.00', discount: '0.00', taxable: '2091.00', vat: '313.65', grand: '2404.65' });
    // A discount: before 180.00, 5% off is 171.00 — each line rounds once, and the page still adds up.
    const d = documentFigures([{ gross: m('180.00'), discountAmount: m('9.00'), total: m('171.00') }], p('15'));
    expect(d.totals).toEqual({ beforeDiscount: '156.52', discount: '7.82', taxable: '148.70', vat: '22.30', grand: '171.00' });
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

  it('DOC-010: the QR holds the document\'s facts as plain text — never ZATCA\'s format', () => {
    const text = documentQrText({ seller: 'Green Skill Agro', title: 'Delivery document', number: 'DN-2026-000013', issued: '2026-10-12 14:05', total: m('2404.65'), vat: m('313.65'), vatRate: p('15') });
    expect(text).toBe('Green Skill Agro\nDelivery document DN-2026-000013\n2026-10-12 14:05\nTotal incl. VAT: 2404.65 SAR\nVAT 15%: 313.65 SAR\nNot a tax invoice — ليست فاتورة ضريبية');
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
