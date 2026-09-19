import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors';
import type { Money } from '../numeric';
import { assertDecisionComment, assertDeclarable, isOverCeiling, reminderDue, remindersEscalate, settlementPostings, transitionSettlement } from './settlements';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };
const m = (v: string) => v as Money;

describe('a cash settlement (workflow M, CSH-002..006, STATE-MACHINES §6)', () => {
  it('CSH-004: submitted is decided once — approved or rejected, never reopened', () => {
    expect(transitionSettlement('SUBMITTED', 'approve')).toBe('APPROVED');
    expect(transitionSettlement('SUBMITTED', 'reject')).toBe('REJECTED');
    expect(code(() => transitionSettlement('APPROVED', 'reject'))).toBe('ALREADY_DECIDED');
    expect(code(() => transitionSettlement('REJECTED', 'approve'))).toBe('ALREADY_DECIDED');
  });

  it('CSH-005: a seller declares no more than the cash in hand the ledger says they hold', () => {
    expect(code(() => assertDeclarable(m('500.00'), m('500.00')))).toBe('NO_ERROR');
    expect(code(() => assertDeclarable(m('500.01'), m('500.00')))).toBe('SETTLEMENT_ABOVE_CASH_IN_HAND');
    expect(code(() => assertDeclarable(m('0.00'), m('500.00')))).toBe('INVALID_MONEY');
  });

  it('CSH-005, CSH-006: approving moves the approved amount out of cash in hand', () => {
    expect(settlementPostings(m('500.00'), m('500.00'), m('500.00')))
      .toEqual({ settlement: '-500.00', discrepancy: null, shortfall: null });
  });

  it('CSH-006: approved for less — the rest stays in the seller\'s hands, recorded', () => {
    expect(settlementPostings(m('500.00'), m('450.00'), m('500.00')))
      .toEqual({ settlement: '-450.00', discrepancy: null, shortfall: '50.00' });
  });

  it('CSH-006: approved for more than the ledger knew about — the extra is a discrepancy, not a negative balance', () => {
    expect(settlementPostings(m('500.00'), m('520.00'), m('500.00')))
      .toEqual({ settlement: '-520.00', discrepancy: '20.00', shortfall: null });
    expect(code(() => settlementPostings(m('500.00'), m('0.00'), m('500.00')))).toBe('INVALID_MONEY');
  });

  it('CSH-006: changing the amount, or refusing it, needs a comment', () => {
    expect(code(() => assertDecisionComment(m('500.00'), m('500.00'), null))).toBe('NO_ERROR');
    expect(code(() => assertDecisionComment(m('500.00'), m('450.00'), null))).toBe('REASON_REQUIRED');
    expect(code(() => assertDecisionComment(m('500.00'), m('450.00'), '  '))).toBe('REASON_REQUIRED');
    expect(code(() => assertDecisionComment(m('500.00'), null, 'Short by 50'))).toBe('NO_ERROR');
    expect(code(() => assertDecisionComment(m('500.00'), null, null))).toBe('REASON_REQUIRED');
  });
});

describe('ceilings (LIM-002..005, OQ-005, OQ-021)', () => {
  it('LIM-002: over the ceiling that applies; without a ceiling there is no breach', () => {
    expect(isOverCeiling(m('5000.00'), m('5000.00'))).toBe(false);
    expect(isOverCeiling(m('5000.01'), m('5000.00'))).toBe(true);
    expect(isOverCeiling(m('99000.00'), null)).toBe(false);
  });

  it('LIM-003, OQ-021: reminders wait for the interval, and escalate to managers from the second', () => {
    const at = new Date('2026-09-20T08:00:00Z');
    expect(reminderDue(at, new Date('2026-09-21T07:59:00Z'), 24)).toBe(false);
    expect(reminderDue(at, new Date('2026-09-21T08:00:00Z'), 24)).toBe(true);
    expect(remindersEscalate(0)).toBe(false);
    expect(remindersEscalate(1)).toBe(true);
    expect(remindersEscalate(4)).toBe(true);
  });
});
