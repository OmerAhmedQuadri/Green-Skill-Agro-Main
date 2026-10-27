import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors';
import type { Money } from '../numeric';
import { importedPaymentAmount, importedSaleFigures } from './index';

const failure = (fn: () => unknown) => {
  try { fn(); return 'NO_ERROR'; } catch (e) { return `${(e as DomainError).code} ${String((e as DomainError).details.field)}`; }
};
const m = (v: string) => v as Money;

describe('imported sales and payments, as the books wrote them (ADR-0059)', () => {
  it('IMP-001: the total is the lines as written less the discount written on the invoice', () => {
    expect(importedSaleFigures([m('3700.00'), m('1781.25')], m('0.00'))).toEqual({ subtotal: '5481.25', total: '5481.25' });
    // A total the seller rounded down — 503.50 written as 500 — is a discount of 3.50.
    expect(importedSaleFigures([m('258.75'), m('244.75')], m('3.50'))).toEqual({ subtotal: '503.50', total: '500.00' });
  });

  it('IMP-001: a line keeps its written amount even where packs × price differ — what the store was charged', () => {
    // 5 × 45 = 225, but 585 was written and charged; the figures take the 585.
    expect(importedSaleFigures([m('585.00'), m('360.00')], m('0.00')).total).toBe('945.00');
  });

  it('IMP-001: no lines, a negative amount or discount, or nothing left to owe is refused', () => {
    expect(failure(() => importedSaleFigures([], m('0.00')))).toBe('INVALID_MONEY lines');
    expect(failure(() => importedSaleFigures([m('-5.00')], m('0.00')))).toBe('INVALID_MONEY amount');
    expect(failure(() => importedSaleFigures([m('100.00')], m('-1.00')))).toBe('INVALID_MONEY discount');
    expect(failure(() => importedSaleFigures([m('100.00')], m('100.00')))).toBe('INVALID_MONEY total');
  });

  it('IMP-002: an imported payment is a positive amount of money', () => {
    expect(importedPaymentAmount('2976.15')).toBe('2976.15');
    expect(failure(() => importedPaymentAmount('0'))).toBe('INVALID_MONEY amount');
    expect(failure(() => importedPaymentAmount('-10.00'))).toBe('INVALID_MONEY amount');
    expect(failure(() => importedPaymentAmount('1,000'))).toMatch(/^INVALID_MONEY/);   // not a number at all
  });
});
