import { describe, expect, it } from 'vitest';
import { type DomainError } from '../errors';
import {
  generateSkuCode, normaliseSkuCode, normaliseVendorCode, packCountOf, packWeightGrams, resolveSkuCode, sizeCode,
} from './codes';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };

describe('SKU codes (CAT-008)', () => {
  it('CAT-008: generates OKRA-PK-5KG from product, variety and pack size', () => {
    expect(generateSkuCode({ productNameEn: 'Okra', varietyNameEn: 'Parbhani Kranti', size: { measure: 'WEIGHT', packWeightG: '5000.000' }, countUnit: 'SEED' }))
      .toBe('OKRA-PK-5KG');
  });

  it('CAT-008: grams, kilograms and seed counts each have a size part', () => {
    expect(sizeCode({ measure: 'WEIGHT', packWeightG: '500.000' }, 'SEED')).toBe('500G');
    expect(sizeCode({ measure: 'WEIGHT', packWeightG: '1000.000' }, 'SEED')).toBe('1KG');
    expect(sizeCode({ measure: 'WEIGHT', packWeightG: '1500.000' }, 'SEED')).toBe('1500G');
    expect(sizeCode({ measure: 'WEIGHT', packWeightG: '0.500' }, 'SEED')).toBe('0.5G');
    expect(sizeCode({ measure: 'COUNT', packCount: 500 }, 'SEED')).toBe('500S');
    expect(sizeCode({ measure: 'COUNT', packCount: 1 }, 'PIECE')).toBe('1PC');
  });

  it('CAT-008: a one-word variety gives its first two letters; a product without varieties has no middle part', () => {
    expect(generateSkuCode({ productNameEn: 'Malokiah', varietyNameEn: 'Baladi', size: { measure: 'WEIGHT', packWeightG: '1000' }, countUnit: 'SEED' }))
      .toBe('MALO-BA-1KG');
    expect(generateSkuCode({ productNameEn: 'Shade Net 50%', varietyNameEn: null, size: { measure: 'COUNT', packCount: 1 }, countUnit: 'PIECE' }))
      .toBe('SHAD-1PC');
  });

  it('CAT-008: spaces and punctuation never reach a generated code', () => {
    expect(generateSkuCode({ productNameEn: 'Red Radish', varietyNameEn: 'Cherry Belle', size: { measure: 'WEIGHT', packWeightG: '50' }, countUnit: 'SEED' }))
      .toBe('REDR-CB-50G');
  });

  it('CAT-008: a clash appends the packaging letter, then a number', () => {
    const taken = new Set(['OKRA-PK-50G', 'OKRA-PK-50G-C']);
    expect(resolveSkuCode('OKRA-PK-50G', 'POUCH', (c) => taken.has(c))).toBe('OKRA-PK-50G-P');
    expect(resolveSkuCode('OKRA-PK-50G', 'CAN', (c) => taken.has(c))).toBe('OKRA-PK-50G-C2');
    expect(resolveSkuCode('BEAN-SN-1KG', 'CAN', (c) => taken.has(c))).toBe('BEAN-SN-1KG');
  });

  it('CAT-008: an overridden code is upper-cased; spaces and symbols are refused', () => {
    expect(normaliseSkuCode(' okra-pk-5kg ')).toBe('OKRA-PK-5KG');
    expect(code(() => normaliseSkuCode('RED -CB-50G'))).toBe('INVALID_SKU_CODE');
    expect(code(() => normaliseSkuCode('-OKRA'))).toBe('INVALID_SKU_CODE');
    expect(code(() => normaliseSkuCode('X'.repeat(41)))).toBe('INVALID_SKU_CODE');
  });

  it('VEN-001: vendor codes follow the same shape', () => {
    expect(normaliseVendorCode('ven-7k4m')).toBe('VEN-7K4M');
    expect(code(() => normaliseVendorCode('VEN 1'))).toBe('INVALID_VENDOR_CODE');
  });
});

describe('pack sizes (CAT-010, CAT-011)', () => {
  it('CAT-010: weight is stored in grams whether entered in g or kg', () => {
    expect(packWeightGrams('5', 'KG')).toBe('5000.000');
    expect(packWeightGrams('0.5', 'KG')).toBe('500.000');
    expect(packWeightGrams('50', 'G')).toBe('50.000');
  });

  it('CAT-010: the minimum weight is 0.1 g', () => {
    expect(packWeightGrams('0.1', 'G')).toBe('0.100');
    expect(packWeightGrams('0.0001', 'KG')).toBe('0.100');
    expect(code(() => packWeightGrams('0.09', 'G'))).toBe('INVALID_PACK_SIZE');
    expect(code(() => packWeightGrams('0', 'KG'))).toBe('INVALID_PACK_SIZE');
  });

  it('CAT-011: weight carries at most three decimals in grams', () => {
    expect(code(() => packWeightGrams('0.1234', 'G'))).toBe('INVALID_PACK_SIZE');
    expect(code(() => packWeightGrams('0.0000001', 'KG'))).toBe('INVALID_PACK_SIZE');
    expect(code(() => packWeightGrams('1e3', 'G'))).toBe('INVALID_PACK_SIZE');
  });

  it('CAT-010: a count is a whole, positive number of seeds', () => {
    expect(packCountOf(500)).toBe(500);
    expect(code(() => packCountOf(0))).toBe('INVALID_PACK_SIZE');
    expect(code(() => packCountOf(2.5))).toBe('INVALID_PACK_SIZE');
  });
});
