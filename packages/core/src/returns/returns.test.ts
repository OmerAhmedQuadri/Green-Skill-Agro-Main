import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors';
import type { Money } from '../numeric';
import {
  assertReturnAllowed, assertReturnKind, checkReturnLines, creditFor, daysSince, heldFromSale, returnConditions, returnOutcome, splitCredit,
  type ReturnRules,
} from './returns';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };
const m = (v: string) => v as Money;
const rules: ReturnRules = { unclearedAllowed: true, unclearedWindowDays: 30, defectiveAllowed: true, defectiveWindowDays: 30 };
const sold = new Date('2026-03-01T09:00:00+03:00');
const later = (days: number) => new Date(sold.getTime() + days * 86_400_000);

describe('conditions and windows (RET-002..006)', () => {
  it('RET-005: the window counts Riyadh calendar days — late on the last day is still inside', () => {
    expect(daysSince(sold, new Date('2026-03-31T23:30:00+03:00'))).toBe(30);
    expect(daysSince(new Date('2026-03-01T23:30:00+03:00'), new Date('2026-03-02T00:10:00+03:00'))).toBe(1);
    expect(code(() => assertReturnAllowed(rules, 'DEFECTIVE', { completedAt: sold, unpaid: m('0.00') }, later(30)))).toBe('NO_ERROR');
    expect(code(() => assertReturnAllowed(rules, 'DEFECTIVE', { completedAt: sold, unpaid: m('0.00') }, later(31)))).toBe('RETURN_WINDOW_CLOSED');
  });

  it('RET-002: not yet cleared needs something still owed on the sale', () => {
    expect(code(() => assertReturnAllowed(rules, 'UNCLEARED_PAYMENT', { completedAt: sold, unpaid: m('40.00') }, later(3)))).toBe('NO_ERROR');
    expect(code(() => assertReturnAllowed(rules, 'UNCLEARED_PAYMENT', { completedAt: sold, unpaid: m('0.00') }, later(3)))).toBe('SALE_ALREADY_PAID');
  });

  it('RET-003: a defect is returnable whatever the payment', () => {
    expect(code(() => assertReturnAllowed(rules, 'DEFECTIVE', { completedAt: sold, unpaid: m('0.00') }, later(3)))).toBe('NO_ERROR');
  });

  it('RET-004: the Admin can allow only one condition', () => {
    const onlyDefective = { ...rules, unclearedAllowed: false };
    expect(code(() => assertReturnAllowed(onlyDefective, 'UNCLEARED_PAYMENT', { completedAt: sold, unpaid: m('40.00') }, later(1)))).toBe('RETURN_CONDITION_DISABLED');
    expect(code(() => assertReturnAllowed(onlyDefective, 'DEFECTIVE', { completedAt: sold, unpaid: m('40.00') }, later(1)))).toBe('NO_ERROR');
  });

  it('RET-006: each condition keeps its own window', () => {
    const states = returnConditions({ ...rules, unclearedWindowDays: 7, defectiveWindowDays: 60 }, { completedAt: sold, unpaid: m('10.00') }, later(10));
    expect(states).toEqual([
      { condition: 'UNCLEARED_PAYMENT', windowDays: 7, daysLeft: -3, blockedBy: 'RETURN_WINDOW_CLOSED' },
      { condition: 'DEFECTIVE', windowDays: 60, daysLeft: 50, blockedBy: null },
    ]);
  });

  it('RET-010: only a defective item is replaced', () => {
    expect(code(() => assertReturnKind('REPLACEMENT', 'UNCLEARED_PAYMENT'))).toBe('REPLACEMENT_ONLY_DEFECTIVE');
    expect(code(() => assertReturnKind('REPLACEMENT', 'DEFECTIVE'))).toBe('NO_ERROR');
    expect(code(() => assertReturnKind('CREDIT_NOTE', 'UNCLEARED_PAYMENT'))).toBe('NO_ERROR');
  });
});

describe('what can come back (RET-001, ADR-0039)', () => {
  const soldBatches = [{ saleLineId: 'L1', batchId: 'B1', packs: 3 }, { saleLineId: 'L1', batchId: 'B2', packs: 2 }];

  it('RET-001: the store holds what it bought, less what came back, plus replacements handed over', () => {
    expect(heldFromSale(soldBatches, [{ saleLineId: 'L1', batchId: 'B1', packs: 3 }, { saleLineId: 'L1', batchId: 'B2', packs: 1 }], [{ saleLineId: 'L1', batchId: 'B9', packs: 1 }]))
      .toEqual([{ saleLineId: 'L1', batchId: 'B2', packs: 1 }, { saleLineId: 'L1', batchId: 'B9', packs: 1 }]);
  });

  it('RET-001: never more of a batch than the store holds from the sale — however the lines are split', () => {
    expect(code(() => checkReturnLines([{ saleLineId: 'L1', batchId: 'B1', packs: 2 }, { saleLineId: 'L1', batchId: 'B1', packs: 2 }], soldBatches))).toBe('RETURN_EXCEEDS_HELD');
    expect(code(() => checkReturnLines([{ saleLineId: 'L1', batchId: 'B7', packs: 1 }], soldBatches))).toBe('RETURN_EXCEEDS_HELD');
    expect(code(() => checkReturnLines([{ saleLineId: 'L1', batchId: 'B1', packs: 3 }, { saleLineId: 'L1', batchId: 'B2', packs: 2 }], soldBatches))).toBe('NO_ERROR');
  });

  it('whole packs, and something to return', () => {
    expect(code(() => checkReturnLines([], soldBatches))).toBe('EMPTY_RETURN');
    expect(code(() => checkReturnLines([{ saleLineId: 'L1', batchId: 'B1', packs: 0 }], soldBatches))).toBe('INVALID_PACK_COUNT');
    expect(code(() => checkReturnLines([{ saleLineId: 'L1', batchId: 'B1', packs: 1.5 }], soldBatches))).toBe('INVALID_PACK_COUNT');
  });
});

describe('the credit note (RET-007, RET-008, OQ-020)', () => {
  it('RET-008: a line is credited pro rata after its discount — returned in parts, it adds up to exactly its total', () => {
    const line = { total: m('100.00'), packs: 3 };
    const parts = [creditFor(line, 0, 1), creditFor(line, 1, 1), creditFor(line, 2, 1)];
    expect(parts).toEqual(['33.33', '33.34', '33.33']);
    expect(parts.reduce((s, p) => s + Number(p) * 100, 0)).toBe(10_000);
    expect(creditFor(line, 0, 3)).toBe('100.00');
    expect(code(() => creditFor(line, 2, 2))).toBe('RETURN_EXCEEDS_HELD');
  });

  it('RET-007: saleable goods go back on their batch; unsaleable, expired or defective ones to write-off', () => {
    expect(returnOutcome('UNCLEARED_PAYMENT', true, false)).toEqual({ outcome: 'RESTOCK', writeOffReason: null });
    expect(returnOutcome('UNCLEARED_PAYMENT', false, false)).toEqual({ outcome: 'WRITE_OFF', writeOffReason: 'DAMAGED' });
    expect(returnOutcome('UNCLEARED_PAYMENT', true, true)).toEqual({ outcome: 'WRITE_OFF', writeOffReason: 'EXPIRED' });
    expect(returnOutcome('DEFECTIVE', true, false)).toEqual({ outcome: 'WRITE_OFF', writeOffReason: 'DEFECTIVE' });
  });

  it('RET-008, OQ-020: the sale\'s unpaid part first, then other debts, then cash back', () => {
    expect(splitCredit(m('300.00'), 'DEFECTIVE', m('100.00'), m('150.00')))
      .toEqual({ toSale: '100.00', toOtherDebts: '150.00', refund: '50.00', collectedPortion: '200.00' });
    expect(splitCredit(m('80.00'), 'DEFECTIVE', m('0.00'), m('0.00')))
      .toEqual({ toSale: '0.00', toOtherDebts: '0.00', refund: '80.00', collectedPortion: '80.00' });
  });

  it('OQ-020: not yet cleared — no more than what is unpaid on the sale, and nothing was collected', () => {
    expect(splitCredit(m('400.00'), 'UNCLEARED_PAYMENT', m('400.00'), m('900.00')))
      .toEqual({ toSale: '400.00', toOtherDebts: '0.00', refund: '0.00', collectedPortion: '0.00' });
    expect(code(() => splitCredit(m('400.01'), 'UNCLEARED_PAYMENT', m('400.00'), m('900.00')))).toBe('RETURN_EXCEEDS_UNPAID');
    expect(code(() => splitCredit(m('0.00'), 'DEFECTIVE', m('0.00'), m('0.00')))).toBe('INVALID_MONEY');
  });
});
