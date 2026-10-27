import { describe, expect, it } from 'vitest';
import { type DomainError } from '../errors';
import {
  correctionReason, correctionSessionEndedAt, correctionSessionEnds, correctionSessionState, settleCorrectionReason,
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
