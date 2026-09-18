import { describe, expect, it } from 'vitest';
import { DomainError } from './errors';
import { dec, money, percent, quantity, toMoney } from './numeric';
import { businessDate, businessMonth } from './time';

describe('exact arithmetic (ADR-0003)', () => {
  it('NFR-008: 0.1 + 0.2 is exactly 0.30', () => {
    expect(toMoney(dec(money('0.1')).plus(money('0.2')))).toBe('0.30');
  });

  it('NFR-008: rounds half-up to 2 places only when converting to Money', () => {
    expect(toMoney(dec('10.005'))).toBe('10.01');
    expect(toMoney(dec('10.004'))).toBe('10.00');
  });

  it('rejects malformed values at the boundary', () => {
    expect(() => money('12.345')).toThrow(DomainError);
    expect(() => quantity('1.2345')).toThrow(DomainError);
    expect(() => percent('100.5')).toThrow(DomainError);
    expect(() => percent('0.5')).not.toThrow(); // 0.5 %, not 50 %
  });
});

describe('business time (Asia/Riyadh)', () => {
  it('23:30 UTC is already the next day in Riyadh', () => {
    expect(businessDate(new Date('2026-03-31T23:30:00Z'))).toBe('2026-04-01');
    expect(businessMonth(new Date('2026-03-31T23:30:00Z'))).toBe('2026-04');
  });
});
