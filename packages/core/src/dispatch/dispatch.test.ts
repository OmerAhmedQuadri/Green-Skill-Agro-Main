import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors';
import type { Money } from '../numeric';
import { assertSaleCredit, transitionSale } from '../sales';
import { creditStatus } from '../stores';
import { checkReceipt, isUnconfirmed, transitionDispatch } from './dispatch';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };
const m = (v: string) => v as Money;

describe('the dispatch order (DSP-001, STATE-MACHINES §3)', () => {
  it('DSP-001: requested → being handled → released → delivered → closed', () => {
    expect(transitionDispatch('REQUESTED', 'take')).toBe('BEING_HANDLED');
    expect(transitionDispatch('BEING_HANDLED', 'release')).toBe('RELEASED');
    expect(transitionDispatch('RELEASED', 'confirm')).toBe('DELIVERED');
    expect(transitionDispatch('DELIVERED', 'resolve')).toBe('CLOSED');
  });

  it('DSP-004, DSP-005: taking is a label — another manager can take it over, or hand it back', () => {
    expect(transitionDispatch('BEING_HANDLED', 'take')).toBe('BEING_HANDLED');
    expect(transitionDispatch('BEING_HANDLED', 'release_back')).toBe('REQUESTED');
  });

  it('DSP-013: once released, only receipt or a lost-order claim — never a cancel', () => {
    expect(transitionDispatch('REQUESTED', 'cancel')).toBe('CLOSED');
    expect(transitionDispatch('BEING_HANDLED', 'cancel')).toBe('CLOSED');
    expect(code(() => transitionDispatch('RELEASED', 'cancel'))).toBe('INVALID_TRANSITION');
    expect(transitionDispatch('RELEASED', 'lose')).toBe('CLOSED');
    expect(code(() => transitionDispatch('CLOSED', 'take'))).toBe('INVALID_TRANSITION');
  });

  it('DSP-003, ADR-0038: a dispatch sale is pending until delivered; an approved one goes to the warehouse', () => {
    expect(transitionSale('DISCOUNT_APPROVED', 'dispatch')).toBe('PENDING_DELIVERY');
    expect(transitionSale('PENDING_DELIVERY', 'deliver')).toBe('COMPLETED');
    expect(transitionSale('PENDING_DELIVERY', 'lose')).toBe('CANCELLED');
    expect(code(() => transitionSale('PENDING_DELIVERY', 'complete'))).toBe('INVALID_TRANSITION');
  });
});

describe('receipt (DSP-009..013, OQ-019)', () => {
  it('DSP-011: every released pack is received, short or damaged — line by line', () => {
    expect(checkReceipt([{ lineId: 'a', released: 10, received: 8, short: 1, damaged: 1 }, { lineId: 'b', released: 3, received: 3, short: 0, damaged: 0 }]))
      .toEqual({ received: 11, shortfall: 2 });
    expect(code(() => checkReceipt([{ lineId: 'a', released: 10, received: 8, short: 1, damaged: 0 }]))).toBe('RECEIPT_MISMATCH');
    expect(code(() => checkReceipt([{ lineId: 'a', released: 10, received: 11, short: -1, damaged: 0 }]))).toBe('INVALID_PACK_COUNT');
  });

  it('DSP-013: nothing arrived is a lost order, not a receipt', () => {
    expect(code(() => checkReceipt([{ lineId: 'a', released: 4, received: 0, short: 4, damaged: 0 }]))).toBe('NOTHING_RECEIVED');
  });

  it('DSP-014: unconfirmed after the configured days, derived when read', () => {
    const released = new Date('2026-09-01T10:00:00Z');
    expect(isUnconfirmed(released, new Date('2026-09-06T09:00:00Z'), 5)).toBe(false);
    expect(isUnconfirmed(released, new Date('2026-09-06T11:00:00Z'), 5)).toBe(true);
    expect(isUnconfirmed(null, new Date('2027-01-01'), 5)).toBe(false);
  });
});

describe('credit for a dispatch order (DSP-002, OQ-018)', () => {
  it('DSP-002: orders waiting for delivery count against the credit left', () => {
    const credit = creditStatus({ status: 'ACTIVE', limit: m('1000.00'), graceDays: 0, today: '2026-09-19', overrideActive: false, openDebits: [{ dueOn: '2026-09-26', open: m('300.00') }] });
    expect(assertSaleCredit(credit, 'WEEKLY', m('400.00'), m('300.00'))).toEqual({ usesOverride: false });
    const refused = (() => { try { assertSaleCredit(credit, 'WEEKLY', m('500.00'), m('300.00')); return null; } catch (e) { return e as DomainError; } })();
    expect(refused).toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED', details: { available: '400.00', total: '500.00' } });
  });
});
