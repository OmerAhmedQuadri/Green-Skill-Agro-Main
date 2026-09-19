import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors';
import { quantity } from '../numeric';
import { planConversion, type ConversionSku } from './conversion';
import { daysBetween, rateFlag, timeFlag } from './expiry';
import { allocateFefo, fefoOrder, type BatchPosition } from './fefo';
import { decideWriteOff } from './write-offs';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };
const sku = (skuId: string, units: ConversionSku['units'], variety = 'pk'): ConversionSku => ({ skuId, productId: 'okra', varietyId: variety, units });
const bag = sku('bag', { measure: 'WEIGHT', packWeightG: '5000' });
const pouch = sku('pouch', { measure: 'WEIGHT', packWeightG: '1000' });
const bagCan = sku('bag-can', { measure: 'WEIGHT', packWeightG: '5000' });
const seeds = sku('seeds', { measure: 'COUNT', packCount: 500 });

describe('SKU conversion (CNV-001..011)', () => {
  it('CNV-001: 20 × 5 kg bags into 99 × 1 kg pouches, 1 kg lost — exact in grams', () => {
    expect(planConversion(bag, pouch, { sourcePacks: 20, targetPacks: 99 })).toEqual({
      sourcePacks: 20, targetPacks: 99, sourceQuantity: '100000.000', targetQuantity: '99000.000', loss: '1000.000',
    });
  });

  it('CNV-001: a change of packaging at the same size is the same function', () => {
    expect(planConversion(bag, bagCan, { sourcePacks: 3, targetPacks: 3 }).loss).toBe('0.000');
  });

  it('CNV-003: conversion runs both ways — pouches combine back into a bag', () => {
    expect(planConversion(pouch, bag, { sourcePacks: 5, targetPacks: 1 }).loss).toBe('0.000');
  });

  it('CNV-011: any two of source, target and loss give the third', () => {
    expect(planConversion(bag, pouch, { sourcePacks: 20, loss: '1000' }).targetPacks).toBe(99);
    expect(planConversion(bag, pouch, { targetPacks: 99, loss: '1000' }).sourcePacks).toBe(20);
    expect(code(() => planConversion(bag, pouch, { sourcePacks: 20 }))).toBe('INVALID_CONVERSION');
  });

  it('CNV-011: a conversion that does not balance is refused', () => {
    expect(code(() => planConversion(bag, pouch, { sourcePacks: 20, targetPacks: 99, loss: '500' }))).toBe('CONVERSION_UNBALANCED');
    expect(code(() => planConversion(bag, pouch, { sourcePacks: 1, targetPacks: 6 }))).toBe('CONVERSION_UNBALANCED');
    expect(code(() => planConversion(bag, pouch, { sourcePacks: 1, loss: '500.5' }))).toBe('CONVERSION_UNBALANCED'); // 4.4995 pouches
  });

  it('CNV-002, CNV-010: same product and variety, same measure', () => {
    expect(code(() => planConversion(bag, sku('other', { measure: 'WEIGHT', packWeightG: '1000' }, 'other'), { sourcePacks: 1, targetPacks: 5 }))).toBe('INVALID_CONVERSION');
    expect(code(() => planConversion(bag, seeds, { sourcePacks: 1, targetPacks: 1 }))).toBe('INVALID_CONVERSION');
    expect(code(() => planConversion(bag, bag, { sourcePacks: 1, targetPacks: 1 }))).toBe('INVALID_CONVERSION');
  });

  it('CNV-005, STK-015: packs moved are whole; only the loss may be part of a pack', () => {
    expect(planConversion(bag, pouch, { sourcePacks: 1, targetPacks: 4 }).loss).toBe('1000.000');
    expect(code(() => planConversion(bag, pouch, { sourcePacks: 1, loss: '0.5' }))).toBe('CONVERSION_UNBALANCED');
    expect(planConversion(bag, pouch, { sourcePacks: 1, targetPacks: 4, loss: '1000' }).loss).toBe('1000.000');
  });
});

const batch = (id: string, expiresOn: string | null, available: string, opts: { flagged?: boolean; received?: string } = {}): BatchPosition => ({
  batchId: id, expiresOn, available: quantity(available), flagged: opts.flagged ?? false, receivedAt: new Date(opts.received ?? '2026-01-01T00:00:00Z'),
});

describe('FEFO allocation (EXP-006, DATA-MODEL §5.4)', () => {
  it('EXP-006: earliest expiry first, no expiry last, oldest receipt breaks ties', () => {
    const order = fefoOrder([
      batch('none', null, '10'), batch('late', '2027-06-01', '10'), batch('early', '2026-12-01', '10'),
      batch('early-newer', '2026-12-01', '10', { received: '2026-02-01T00:00:00Z' }),
    ]);
    expect(order.map((b) => b.batchId)).toEqual(['early', 'early-newer', 'late', 'none']);
  });

  it('EXP-006: a flagged batch is proposed before any other', () => {
    expect(fefoOrder([batch('early', '2026-12-01', '10'), batch('flagged', '2027-06-01', '10', { flagged: true })])[0]?.batchId).toBe('flagged');
  });

  it('EXP-006: takes across batches; a shortfall is returned, not thrown', () => {
    const batches = [batch('a', '2026-12-01', '10000'), batch('b', '2027-01-01', '5000'), batch('c', '2027-02-01', '0')];
    expect(allocateFefo(quantity('12000'), batches)).toEqual({ kind: 'ALLOCATED', allocations: [{ batchId: 'a', quantity: '10000.000' }, { batchId: 'b', quantity: '2000.000' }] });
    expect(allocateFefo(quantity('20000'), batches)).toMatchObject({ kind: 'SHORTFALL', shortfall: '5000.000' });
  });
});

describe('expiry flags (EXP-001..005, EXP-008)', () => {
  it('EXP-001: a batch is flagged within its category\'s warning window, and once expired', () => {
    expect(timeFlag('2026-12-01', '2026-09-19', 90)).toBe(true);
    expect(timeFlag('2027-03-01', '2026-09-19', 90)).toBe(false);
    expect(timeFlag('2026-09-01', '2026-09-19', 90)).toBe(true);
    expect(daysBetween('2026-09-19', '2026-12-18')).toBe(90);
  });

  const base = { held: quantity('50000'), expiresOn: '2027-01-01', today: '2026-09-19', soldSeasonal: null, daysHeld: 60, basis: 'TRAILING' as const };

  it('EXP-002, EXP-003: flagged when what is held will not sell before it expires', () => {
    // 104 days left; 5000 g a month sells 50 kg in 300 days.
    expect(rateFlag({ ...base, soldTrailing: quantity('5000') })).toMatchObject({ flagged: true, reason: 'WONT_CLEAR', daysToClear: 300 });
    expect(rateFlag({ ...base, soldTrailing: quantity('50000') })).toMatchObject({ flagged: false, daysToClear: 30 });
    expect(rateFlag({ ...base, soldTrailing: quantity('0') })).toMatchObject({ flagged: true, reason: 'NO_RECENT_SALES' });
  });

  it('EXP-004, EXP-005: trailing, seasonal, or the more conservative of the two', () => {
    const s = { ...base, soldTrailing: quantity('50000'), soldSeasonal: quantity('5000') };
    expect(rateFlag({ ...s, basis: 'TRAILING' }).flagged).toBe(false);
    expect(rateFlag({ ...s, basis: 'SEASONAL' })).toMatchObject({ flagged: true, basisUsed: 'SEASONAL' });
    expect(rateFlag({ ...s, basis: 'CONSERVATIVE' }).flagged).toBe(true);
  });

  it('EXP-008: without a year of history, the trailing average is used whatever the setting', () => {
    expect(rateFlag({ ...base, soldTrailing: quantity('50000'), soldSeasonal: null, basis: 'SEASONAL' })).toMatchObject({ flagged: false, basisUsed: 'TRAILING' });
  });

  it('EXP-003: a batch held less than a full window is not judged on rate yet', () => {
    expect(rateFlag({ ...base, soldTrailing: quantity('0'), daysHeld: 10 })).toMatchObject({ flagged: false, tooSoon: true });
  });
});

describe('write-off decisions (WRO-003, WRO-004, STATE-MACHINES §5)', () => {
  const submitted = { status: 'SUBMITTED' as const, submittedBy: 'warehouse', requestedPacks: 5 };

  it('WRO-004: approve as submitted, approve fewer, or reject with a comment', () => {
    expect(decideWriteOff(submitted, { approve: true }, 'manager')).toEqual({ status: 'APPROVED', approvedPacks: 5 });
    expect(decideWriteOff(submitted, { approve: true, approvedPacks: 3 }, 'manager')).toEqual({ status: 'APPROVED', approvedPacks: 3 });
    expect(code(() => decideWriteOff(submitted, { approve: true, approvedPacks: 6 }, 'manager'))).toBe('INVALID_PACK_COUNT');
    expect(code(() => decideWriteOff(submitted, { approve: false }, 'manager'))).toBe('REASON_REQUIRED');
    expect(decideWriteOff(submitted, { approve: false, comment: 'Still saleable' }, 'manager').status).toBe('REJECTED');
  });

  it('WRO-003: the submitter cannot approve their own write-off, and a decided one stays decided', () => {
    expect(code(() => decideWriteOff(submitted, { approve: true }, 'warehouse'))).toBe('FOUR_EYES');
    expect(code(() => decideWriteOff({ ...submitted, status: 'APPROVED' }, { approve: true }, 'manager'))).toBe('ALREADY_DECIDED');
  });
});
