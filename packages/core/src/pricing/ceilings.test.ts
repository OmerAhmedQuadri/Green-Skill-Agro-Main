import { describe, expect, it } from 'vitest';
import { type DomainError } from '../errors';
import { percent } from '../numeric';
import { applicableItemCeiling, assertWithinMaximum, price } from './ceilings';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };

describe('prices and discount ceilings', () => {
  it('PRC-001: a price is a positive SAR amount with at most two decimals', () => {
    expect(price('86.10')).toBe('86.10');
    expect(code(() => price('0'))).toBe('INVALID_PRICE');
    expect(code(() => price('13.915'))).toBe('INVALID_MONEY');
  });

  it('PRC-006: the tighter of the item and order ceilings governs', () => {
    expect(applicableItemCeiling(percent('10'), percent('5'))).toBe('5');
    expect(applicableItemCeiling(percent('10'), percent('12.5'))).toBe('10');
  });

  it('PRC-016: no ceiling may exceed the absolute maximum', () => {
    expect(code(() => assertWithinMaximum(percent('30'), percent('25'), 'discount.order_ceiling'))).toBe('CEILING_ABOVE_MAXIMUM');
    expect(code(() => assertWithinMaximum(percent('25'), percent('25'), 'discount.order_ceiling'))).toBe('NO_ERROR');
  });
});
