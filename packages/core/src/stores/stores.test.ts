import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors';
import type { Money } from '../numeric';
import { allocateCredit, assertCreditTerms, creditStatus, dueDateFor } from './credit';
import { findDuplicates, initialStoreStatus, nameSimilarity, normaliseContactNumber, normaliseStoreName, transitionStore } from './stores';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };
const m = (v: string) => v as Money;

describe('store lifecycle (STATE-MACHINES §4)', () => {
  it('STO-009, STO-010: with approval on a new store waits; with it off it starts active', () => {
    expect(initialStoreStatus(true)).toBe('PENDING_APPROVAL');
    expect(initialStoreStatus(false)).toBe('ACTIVE');
  });

  it('STO-009: approval is four-eyes; a rejection needs a reason; a decided store stays decided', () => {
    const pending = { status: 'PENDING_APPROVAL' as const, onboardedBy: 'seller' };
    expect(transitionStore(pending, 'approve', 'manager')).toBe('ACTIVE');
    expect(code(() => transitionStore(pending, 'approve', 'seller'))).toBe('FOUR_EYES');
    expect(code(() => transitionStore(pending, 'reject', 'manager', ' '))).toBe('REASON_REQUIRED');
    expect(transitionStore(pending, 'reject', 'manager', 'Duplicate of an existing store')).toBe('REJECTED');
    expect(code(() => transitionStore({ status: 'ACTIVE', onboardedBy: 'seller' }, 'approve', 'manager'))).toBe('ALREADY_DECIDED');
    expect(transitionStore({ status: 'ACTIVE', onboardedBy: 's' }, 'deactivate', 'm')).toBe('INACTIVE');
    expect(transitionStore({ status: 'INACTIVE', onboardedBy: 's' }, 'reactivate', 'm')).toBe('ACTIVE');
  });

  it('STO-001: a contact number is a Saudi mobile or landline in any local form, or E.164', () => {
    expect(normaliseContactNumber('050 123 4567')).toBe('+966501234567');
    expect(normaliseContactNumber('011-234-5678')).toBe('+966112345678');
    expect(normaliseContactNumber('+971501234567')).toBe('+971501234567');
    expect(code(() => normaliseContactNumber('12'))).toBe('INVALID_PHONE');
  });
});

describe('duplicate detection (STO-008, OQ-006)', () => {
  const t = { radiusM: 150, nameRadiusM: 1000, nameSimilarityPercent: 60 };
  const here = { lat: 24.7136, lng: 46.6753 };

  it('STO-008: Arabic spellings people use interchangeably compare as one', () => {
    expect(normaliseStoreName('مؤسسة الأمل للبذور')).toBe(normaliseStoreName('مؤسسه الامل للبذور'));
    expect(normaliseStoreName('Al-Amal  Seeds!')).toBe('al amal seeds');
    expect(nameSimilarity('Al Amal Seeds', 'al amal seeds')).toBe(1);
    expect(nameSimilarity('Al Amal Seeds', 'Riyadh Farm Supply')).toBeLessThan(0.2);
  });

  it('STO-008: a store close by, or of a similar name within a kilometre, is a likely duplicate', () => {
    const existing = [
      { id: 'near', name: 'Totally Different Name', lat: here.lat + 100 / 111_195, lng: here.lng },
      { id: 'similar', name: 'مؤسسه الامل للبذور', lat: here.lat + 600 / 111_195, lng: here.lng },
      { id: 'far-similar', name: 'مؤسسة الأمل للبذور', lat: here.lat + 3000 / 111_195, lng: here.lng },
      { id: 'unrelated', name: 'Farm Tools', lat: here.lat + 500 / 111_195, lng: here.lng },
    ];
    const found = findDuplicates({ ...here, name: 'مؤسسة الأمل للبذور' }, existing, t);
    expect(found.map((f) => [f.storeId, f.reasons])).toEqual([['near', ['NEARBY']], ['similar', ['SIMILAR_NAME']]]);
  });
});

describe('credit cycles (CRD-001..007, OQ-018)', () => {
  it('CRD-001, OQ-018: bill to bill is due the same day; weekly on the Saturday closing its week', () => {
    expect(dueDateFor('BILL_TO_BILL', null, '2026-10-07')).toBe('2026-10-07');
    expect(dueDateFor('WEEKLY', null, '2026-10-04')).toBe('2026-10-10'); // Sunday → Saturday
    expect(dueDateFor('WEEKLY', null, '2026-10-08')).toBe('2026-10-10'); // Thursday
    expect(dueDateFor('WEEKLY', null, '2026-10-10')).toBe('2026-10-10'); // Saturday itself
  });

  it('CRD-001, OQ-018: the Admin may close the week on another day — Thursday, say', () => {
    expect(dueDateFor('WEEKLY', null, '2026-10-04', 'THURSDAY')).toBe('2026-10-08'); // Sunday → Thursday
    expect(dueDateFor('WEEKLY', null, '2026-10-08', 'THURSDAY')).toBe('2026-10-08'); // Thursday itself
    expect(dueDateFor('WEEKLY', null, '2026-10-09', 'THURSDAY')).toBe('2026-10-15'); // Friday → next Thursday
  });

  it('CRD-001, OQ-018: monthly is due on the month\'s last day; custom N days after each sale', () => {
    expect(dueDateFor('MONTHLY', null, '2026-02-10')).toBe('2026-02-28');
    expect(dueDateFor('MONTHLY', null, '2028-02-10')).toBe('2028-02-29');
    expect(dueDateFor('MONTHLY', null, '2026-12-31')).toBe('2026-12-31');
    expect(dueDateFor('CUSTOM', 15, '2026-12-25')).toBe('2027-01-09');
  });

  it('CRD-002: only modes the Admin offers; a custom cycle needs its days', () => {
    const offered = new Set(['WEEKLY', 'CUSTOM'] as const);
    expect(assertCreditTerms('WEEKLY', null, offered)).toBeNull();
    expect(code(() => assertCreditTerms('MONTHLY', null, offered))).toBe('CREDIT_MODE_UNAVAILABLE');
    expect(code(() => assertCreditTerms('CUSTOM', null, offered))).toBe('CREDIT_MODE_UNAVAILABLE');
    expect(assertCreditTerms('CUSTOM', 21, offered)).toBe(21);
  });

  it('CRD-003: a payment settles the oldest due first; partial payments carry the rest forward', () => {
    const debits = [
      { id: 'later', dueOn: '2026-10-17', occurredAt: new Date('2026-10-12T08:00:00Z'), open: m('300.00') },
      { id: 'older', dueOn: '2026-10-10', occurredAt: new Date('2026-10-05T08:00:00Z'), open: m('200.00') },
    ];
    expect(allocateCredit(m('250.00'), debits)).toEqual([{ debitId: 'older', amount: '200.00' }, { debitId: 'later', amount: '50.00' }]);
    expect(code(() => allocateCredit(m('500.01'), debits))).toBe('PAYMENT_EXCEEDS_BALANCE');
    expect(code(() => allocateCredit(m('0.00'), debits))).toBe('INVALID_MONEY');
  });

  it('RET-008: a credit note settles its own sale first, then the oldest debts', () => {
    const debits = [
      { id: 'later', dueOn: '2026-10-17', occurredAt: new Date('2026-10-12T08:00:00Z'), open: m('300.00') },
      { id: 'older', dueOn: '2026-10-10', occurredAt: new Date('2026-10-05T08:00:00Z'), open: m('200.00') },
    ];
    expect(allocateCredit(m('350.00'), debits, 'later')).toEqual([{ debitId: 'later', amount: '300.00' }, { debitId: 'older', amount: '50.00' }]);
    expect(allocateCredit(m('100.00'), debits, 'gone')).toEqual([{ debitId: 'older', amount: '100.00' }]);
  });

  it('CRD-004, CRD-005: past due or over the limit blocks, each with its reason; grace delays past due', () => {
    const base = { status: 'ACTIVE' as const, limit: m('1000.00'), graceDays: 0, today: '2026-10-12', overrideActive: false };
    expect(creditStatus({ ...base, openDebits: [{ dueOn: '2026-10-17', open: m('400.00') }] }))
      .toMatchObject({ blocked: false, outstanding: '400.00', available: '600.00', reasons: [] });
    expect(creditStatus({ ...base, openDebits: [{ dueOn: '2026-10-10', open: m('400.00') }] }))
      .toMatchObject({ blocked: true, pastDue: '400.00', reasons: [{ code: 'PAST_DUE', amount: '400.00', oldestDueOn: '2026-10-10' }] });
    expect(creditStatus({ ...base, graceDays: 2, openDebits: [{ dueOn: '2026-10-10', open: m('400.00') }] }).blocked).toBe(false);
    expect(creditStatus({ ...base, openDebits: [{ dueOn: '2026-10-17', open: m('1000.01') }] }).reasons)
      .toEqual([{ code: 'OVER_LIMIT', outstanding: '1000.01', limit: '1000.00' }]);
    expect(creditStatus({ ...base, limit: m('0.00'), openDebits: [{ dueOn: '2026-10-17', open: m('0.01') }] }).blocked).toBe(true);
  });

  it('CRD-006, STO-009: an override lifts a credit block for the day, never an unapproved store', () => {
    const owed = { limit: m('100.00'), graceDays: 0, today: '2026-10-12', openDebits: [{ dueOn: '2026-10-01', open: m('50.00') }] };
    expect(creditStatus({ ...owed, status: 'ACTIVE', overrideActive: true })).toMatchObject({ blocked: false, overridden: true });
    expect(creditStatus({ ...owed, status: 'PENDING_APPROVAL', overrideActive: true })).toMatchObject({ blocked: true, overridden: false });
    expect(creditStatus({ ...owed, openDebits: [], status: 'PENDING_APPROVAL', overrideActive: false }).reasons).toEqual([{ code: 'NOT_APPROVED' }]);
  });
});
