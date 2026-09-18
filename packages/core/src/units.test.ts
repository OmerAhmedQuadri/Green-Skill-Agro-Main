import { describe, expect, it } from 'vitest';
import { DomainError } from './errors';
import { dec, quantity } from './numeric';
import {
  assertWholePacks, isWholePacks, packCount, toBaseUnits, toPacks, type SkuUnits,
} from './units';

const bag5kg: SkuUnits = { measure: 'WEIGHT', packWeightG: '5000' };
const pouch1kg: SkuUnits = { measure: 'WEIGHT', packWeightG: '1000' };
const bag3kg: SkuUnits = { measure: 'WEIGHT', packWeightG: '3000' };
const can500: SkuUnits = { measure: 'COUNT', packCount: 500 };

describe('base units and packs', () => {
  it('STK-014: ten 5 kg bags are stored as 50000 grams', () => {
    expect(toBaseUnits(packCount(10), bag5kg)).toBe('50000.000');
  });

  it('STK-014: count SKUs store seeds', () => {
    expect(toBaseUnits(packCount(3), can500)).toBe('1500.000');
  });

  it('STK-014: base units convert back to whole packs', () => {
    expect(toPacks(quantity('50000.000'), bag5kg).toString()).toBe('10');
  });

  it('STK-015: a whole-pack quantity passes; a part-pack is refused', () => {
    expect(isWholePacks(quantity('15000'), bag5kg)).toBe(true);
    expect(() => assertWholePacks(quantity('12500'), bag5kg)).toThrow(DomainError);
  });

  it('ADR-0015: a conversion balances exactly in grams, though the loss is a part-pack', () => {
    const source = toBaseUnits(packCount(20), bag5kg);   // 100000 g
    const target = toBaseUnits(packCount(99), pouch1kg); // 99000 g
    const loss = '1000';
    expect(dec(source).minus(target).minus(loss).isZero()).toBe(true);
    expect(isWholePacks(quantity(loss), bag5kg)).toBe(false); // 0.2 bag — why packs cannot be the stored unit
  });

  it('ADR-0015: 1 g lost from a 3 kg pack is exact in grams, repeating in packs', () => {
    expect(toPacks(quantity('1'), bag3kg).decimalPlaces()).toBeGreaterThan(3);
  });

  it('CAT-010: weight packs must be at least 0.1 g', () => {
    expect(() => toBaseUnits(packCount(1), { measure: 'WEIGHT', packWeightG: '0.05' })).toThrow(DomainError);
    expect(toBaseUnits(packCount(1), { measure: 'WEIGHT', packWeightG: '0.1' })).toBe('0.100');
  });

  it('pack counts must be non-negative integers', () => {
    expect(() => packCount(1.5)).toThrow(DomainError);
    expect(() => packCount(-1)).toThrow(DomainError);
  });
});
