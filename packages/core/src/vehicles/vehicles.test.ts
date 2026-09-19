import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors';
import type { Money } from '../numeric';
import { ceilingCheck, confirmHandoverBy, normaliseRegistration, odometerReading, transitionLoad } from './vehicles';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };

describe('vehicle register', () => {
  it('VEH-001: a registration is normalised — spaces collapsed, Latin letters upper-cased, Arabic kept', () => {
    expect(normaliseRegistration('  abc   1234 ')).toBe('ABC 1234');
    expect(normaliseRegistration('أ ب ج 1234')).toBe('أ ب ج 1234');
    expect(code(() => normaliseRegistration('x'))).toBe('INVALID_REGISTRATION');
    expect(code(() => normaliseRegistration('AB/12'))).toBe('INVALID_REGISTRATION');
  });

  it('VEH-004: an odometer reading is whole kilometres', () => {
    expect(odometerReading(120_450)).toBe(120_450);
    expect(code(() => odometerReading(-1))).toBe('INVALID_ODOMETER');
    expect(code(() => odometerReading(10.5))).toBe('INVALID_ODOMETER');
  });
});

describe('vehicle loads (STATE-MACHINES §7)', () => {
  it('VEH-007: the seller confirms or disputes an issued load; a dispute needs a comment', () => {
    expect(transitionLoad('ISSUED', 'confirm')).toBe('CONFIRMED');
    expect(transitionLoad('ISSUED', 'dispute', 'Two bags short')).toBe('DISPUTED');
    expect(code(() => transitionLoad('ISSUED', 'dispute', ' '))).toBe('REASON_REQUIRED');
    expect(code(() => transitionLoad('DISPUTED', 'confirm'))).toBe('INVALID_TRANSITION');
  });

  it('VEH-007: a disputed load is amended back to issued, or cancelled; a finished one stays finished', () => {
    expect(transitionLoad('DISPUTED', 'amend')).toBe('ISSUED');
    expect(transitionLoad('DISPUTED', 'cancel', 'Reissued')).toBe('CANCELLED');
    expect(code(() => transitionLoad('CONFIRMED', 'cancel', 'x'))).toBe('ALREADY_DECIDED');
    expect(code(() => transitionLoad('CANCELLED', 'amend'))).toBe('ALREADY_DECIDED');
  });

  it('VEH-006: the load is valued with what the vehicle already carries against the ceiling', () => {
    expect(ceilingCheck({ current: '4000.00' as Money, load: '1500.00' as Money, ceiling: '5000.00' as Money }))
      .toEqual({ projected: '5500.00', ceiling: '5000.00', breach: true, excess: '500.00' });
    expect(ceilingCheck({ current: '0.00' as Money, load: '5000.00' as Money, ceiling: '5000.00' as Money }).breach).toBe(false);
    expect(ceilingCheck({ current: '9999.00' as Money, load: '1.00' as Money, ceiling: null })).toMatchObject({ breach: false, excess: '0.00' });
  });
});

describe('vehicle handovers (STATE-MACHINES §8)', () => {
  const proposed = { status: 'PROPOSED' as const, outgoingSellerId: 'out', incomingSellerId: 'in', outgoingConfirmedAt: null, incomingConfirmedAt: null };

  it('VEH-009: both sellers confirm, in either order; the second completes it', () => {
    expect(confirmHandoverBy(proposed, 'in')).toEqual({ side: 'INCOMING', complete: false });
    expect(confirmHandoverBy({ ...proposed, incomingConfirmedAt: new Date() }, 'out')).toEqual({ side: 'OUTGOING', complete: true });
  });

  it('VEH-009: nobody else confirms, and nobody confirms twice', () => {
    expect(code(() => confirmHandoverBy(proposed, 'someone'))).toBe('NOT_FOUND');
    expect(code(() => confirmHandoverBy({ ...proposed, outgoingConfirmedAt: new Date() }, 'out'))).toBe('ALREADY_DECIDED');
    expect(code(() => confirmHandoverBy({ ...proposed, status: 'CANCELLED' }, 'out'))).toBe('ALREADY_DECIDED');
  });
});
