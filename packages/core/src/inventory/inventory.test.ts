import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors';
import { quantity, type Quantity } from '../numeric';
import { batchIdentity, expiryFromShelfLife, isoDate } from './batch';
import { assertBalanced, isInternal, sellable, transfer, type Leg } from './postings';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };
const warehouse = { kind: 'WAREHOUSE', warehouseId: 'w1' } as const;
const supplier = { kind: 'SUPPLIER' } as const;
const q = (v: string): Quantity => quantity(v);

describe('the stock ledger rules (DATA-MODEL §3.1)', () => {
  it('STK-013: a movement is a pair of legs that balance per batch', () => {
    const legs = transfer({ id: 'b1', balanceKey: 'v1' }, q('50000'), supplier, warehouse);
    expect(legs.map((l) => l.quantity)).toEqual(['-50000.000', '50000.000']);
    expect(code(() => assertBalanced(legs, 'PER_BATCH'))).toBe('NO_ERROR');
  });

  it('STK-013: an unbalanced group, a single leg or a zero leg is refused', () => {
    const leg = (batchId: string, qty: string): Leg => ({ batchId, balanceKey: 'v1', account: warehouse, quantity: q(qty) });
    expect(code(() => assertBalanced([leg('b1', '10'), leg('b1', '-9')], 'PER_BATCH'))).toBe('UNBALANCED_POSTING');
    expect(code(() => assertBalanced([leg('b1', '10')], 'PER_BATCH'))).toBe('UNBALANCED_POSTING');
    expect(code(() => assertBalanced([leg('b1', '0'), leg('b1', '0')], 'PER_BATCH'))).toBe('UNBALANCED_POSTING');
  });

  it('CNV-010: a conversion balances per variety across two batches, never per batch', () => {
    const legs: Leg[] = [
      { batchId: 'bag', balanceKey: 'okra-pk', account: warehouse, quantity: q('-100000') },
      { batchId: 'pouch', balanceKey: 'okra-pk', account: warehouse, quantity: q('99000') },
      { batchId: 'bag', balanceKey: 'okra-pk', account: { kind: 'WRITTEN_OFF' }, quantity: q('1000') },
    ];
    expect(code(() => assertBalanced(legs, 'PER_VARIETY'))).toBe('NO_ERROR');
    expect(code(() => assertBalanced(legs, 'PER_BATCH'))).toBe('UNBALANCED_POSTING');
  });

  it('DSP-008: dispatched stock is internal, but it is its own account', () => {
    expect(['WAREHOUSE', 'VEHICLE', 'DISPATCHED'].every((k) => isInternal(k as 'WAREHOUSE'))).toBe(true);
    expect(isInternal('SUPPLIER') || isInternal('SOLD') || isInternal('WRITTEN_OFF')).toBe(false);
  });

  it('PRC-011: sellable stock is the position less holds, never negative', () => {
    expect(sellable(q('50000'), [q('10000'), q('5000')])).toBe('35000.000');
    expect(sellable(q('5000'), [q('10000')])).toBe('0.000');
  });
});

describe('batches and expiry (STK-001, STK-002, RCV-005, RCV-006)', () => {
  it('STK-002: a batch is SKU + LOT + MFD + expiry; the LOT is kept as written, trimmed', () => {
    expect(batchIdentity({ lotNumber: '  8251 ', manufacturedOn: '2026-01-10', expiresOn: '2028-01-10' }))
      .toEqual({ lotNumber: '8251', manufacturedOn: '2026-01-10', expiresOn: '2028-01-10' });
    expect(batchIdentity({})).toEqual({ lotNumber: null, manufacturedOn: null, expiresOn: null });
  });

  it('RCV-005: dates are real calendar dates, and expiry follows manufacture', () => {
    expect(code(() => isoDate('2026-02-30', 'manufacturedOn'))).toBe('INVALID_DATE');
    expect(code(() => isoDate('10/01/2026', 'manufacturedOn'))).toBe('INVALID_DATE');
    expect(code(() => batchIdentity({ manufacturedOn: '2026-05-01', expiresOn: '2026-05-01' }))).toBe('EXPIRY_BEFORE_MANUFACTURE');
  });

  it('RCV-006: expiry from a shelf-life period in months or years', () => {
    expect(expiryFromShelfLife('2026-01-15', { months: 24 })).toBe('2028-01-15');
    expect(expiryFromShelfLife('2026-01-15', { years: 2 })).toBe('2028-01-15');
    expect(expiryFromShelfLife('2026-01-31', { months: 1 })).toBe('2026-02-28');
    expect(expiryFromShelfLife('2027-12-31', { months: 2 })).toBe('2028-02-29');
    expect(code(() => expiryFromShelfLife('2026-01-15', { months: 0 }))).toBe('INVALID_SHELF_LIFE');
  });
});
