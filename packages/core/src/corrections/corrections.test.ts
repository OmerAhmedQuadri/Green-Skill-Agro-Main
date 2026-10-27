import { describe, expect, it } from 'vitest';
import { type DomainError } from '../errors';
import { money } from '../numeric';
import {
  correctedStoreEntry, correctionReason, correctionSessionEndedAt, correctionSessionEnds, correctionSessionState, onDate, settleCorrectionReason,
  storeEntryKind, type StoreEntryValues,
} from './index';

const errorOf = (fn: () => unknown) => { try { fn(); } catch (e) { return e as DomainError; } return undefined; };
const opened = new Date('2026-10-27T09:00:00Z');
const endsAt = correctionSessionEnds(opened);

describe('correction sessions', () => {
  it('COR-001: a session is open for an hour, then ends by itself until its reason is settled', () => {
    expect(endsAt.toISOString()).toBe('2026-10-27T10:00:00.000Z');
    expect(correctionSessionState({ endsAt, closedAt: null }, new Date('2026-10-27T09:59:59Z'))).toBe('OPEN');
    expect(correctionSessionState({ endsAt, closedAt: null }, endsAt)).toBe('ENDED');
    expect(correctionSessionState({ endsAt, closedAt: new Date('2026-10-27T09:20:00Z') }, new Date('2026-10-27T09:30:00Z'))).toBe('CLOSED');
  });

  it('COR-001: it stopped when it was closed, or at the end of its hour if that came first', () => {
    expect(correctionSessionEndedAt({ endsAt }, new Date('2026-10-27T09:20:00Z')).toISOString()).toBe('2026-10-27T09:20:00.000Z');
    expect(correctionSessionEndedAt({ endsAt }, new Date('2026-10-28T08:00:00Z')).toISOString()).toBe('2026-10-27T10:00:00.000Z');
  });

  it('COR-001: a session needs a reason', () => {
    expect(correctionReason('  Fix the voucher numbers of Haneef\'s October book  ')).toBe('Fix the voucher numbers of Haneef\'s October book');
    expect(errorOf(() => correctionReason('   '))?.code).toBe('REASON_REQUIRED');
    expect(errorOf(() => correctionReason(null))?.details).toEqual({ field: 'reason' });
  });

  it('COR-003: closing keeps the reason, adds to it, or edits it — adding and editing need the words', () => {
    const reason = 'Fix two vouchers';
    expect(settleCorrectionReason(reason, 'KEPT', 'ignored')).toEqual({ closing: 'KEPT', text: null });
    expect(settleCorrectionReason(reason, 'ADDED', ' and one date ')).toEqual({ closing: 'ADDED', text: 'and one date' });
    expect(settleCorrectionReason(reason, 'EDITED', 'Fix three vouchers')).toEqual({ closing: 'EDITED', text: 'Fix three vouchers' });
    expect(settleCorrectionReason(reason, 'EDITED', ` ${reason} `)).toEqual({ closing: 'KEPT', text: null });
    expect(errorOf(() => settleCorrectionReason(reason, 'ADDED', ''))?.details).toEqual({ field: 'closingText' });
    expect(errorOf(() => settleCorrectionReason(reason, 'EDITED', null))?.code).toBe('REASON_REQUIRED');
  });
});

describe('store-account corrections', () => {
  const bill: StoreEntryValues = { amount: money('300.00'), date: '2026-10-11', storeId: 'store-a', voucherNumber: null };
  const payment: StoreEntryValues = { ...bill, amount: money('1000.00'), voucherNumber: '1234' };
  const today = '2026-10-27';

  it('COR-005: payments, imported bills, adjustments and corrected bills are corrected here; an app sale through the sale', () => {
    expect(storeEntryKind({ entryType: 'PAYMENT', amount: '-100.00', referenceType: 'PAYMENT' })).toBe('PAYMENT');
    for (const referenceType of ['IMPORTED_SALE', 'ADJUSTMENT', 'CORRECTION']) {
      expect(storeEntryKind({ entryType: referenceType === 'IMPORTED_SALE' ? 'SALE' : 'ADJUSTMENT', amount: '50.00', referenceType })).toBe('BILL');
    }
    expect(errorOf(() => storeEntryKind({ entryType: 'SALE', amount: '90.00', referenceType: 'SALE' }))?.code).toBe('CORRECT_THROUGH_SALE');
    expect(errorOf(() => storeEntryKind({ entryType: 'CREDIT_NOTE', amount: '-90.00', referenceType: 'RETURN' }))?.code).toBe('NOT_CORRECTABLE');
    expect(errorOf(() => storeEntryKind({ entryType: 'ADJUSTMENT', amount: '90.00', referenceType: 'TRANSFER_NOT_RECEIVED' }))?.code).toBe('NOT_CORRECTABLE');
    expect(errorOf(() => storeEntryKind({ entryType: 'ADJUSTMENT', amount: '-90.00', referenceType: 'CORRECTION_REVERSAL' }))?.details).toEqual({ reason: 'REVERSAL' });
  });

  it('COR-005: what is not given stays; a removal leaves nothing; something must change', () => {
    expect(correctedStoreEntry('PAYMENT', payment, { amount: '100' }, today)).toEqual({ ...payment, amount: '100.00' });
    expect(correctedStoreEntry('PAYMENT', payment, { voucherNumber: ' 00 1235 ', storeId: 'store-b' }, today))
      .toEqual({ ...payment, voucherNumber: '1235', storeId: 'store-b' });
    expect(correctedStoreEntry('BILL', bill, { date: '2026-10-09' }, today)).toEqual({ ...bill, date: '2026-10-09' });
    expect(correctedStoreEntry('BILL', bill, { remove: true, amount: '5' }, today)).toBeNull();
    expect(errorOf(() => correctedStoreEntry('BILL', bill, { amount: '300', date: '2026-10-11' }, today))?.code).toBe('NOTHING_TO_CORRECT');
    expect(errorOf(() => correctedStoreEntry('PAYMENT', payment, { voucherNumber: '1234' }, today))?.code).toBe('NOTHING_TO_CORRECT');
  });

  it('COR-005: an amount above nothing, a real date not after today, and no voucher on a bill', () => {
    expect(errorOf(() => correctedStoreEntry('BILL', bill, { amount: '0' }, today))?.code).toBe('INVALID_MONEY');
    expect(errorOf(() => correctedStoreEntry('BILL', bill, { date: '2026-10-28' }, today))?.code).toBe('INVALID_DATE');
    expect(errorOf(() => correctedStoreEntry('BILL', bill, { date: '2026-02-30' }, today))?.code).toBe('INVALID_DATE');
    expect(errorOf(() => correctedStoreEntry('BILL', bill, { voucherNumber: '77' }, today))?.details).toEqual({ field: 'voucherNumber' });
  });

  it('COR-005: a corrected date keeps the time of day', () => {
    expect(onDate(new Date('2026-10-11T07:30:00Z'), '2026-10-11', '2026-10-09').toISOString()).toBe('2026-10-09T07:30:00.000Z');
    expect(onDate(new Date('2026-10-11T07:30:00Z'), '2026-10-11', '2026-11-02').toISOString()).toBe('2026-11-02T07:30:00.000Z');
  });
});
