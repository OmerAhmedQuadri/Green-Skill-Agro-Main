import { describe, expect, it } from 'vitest';
import { effectivePermissions, type PermissionCode } from '../identity';
import {
  DECISION_QUEUES, decisionQueuesFor, isRequestKind, NOTIFICATION_KINDS, PROVISIONAL_OUTCOMES, REQUEST_ENDS, REQUEST_KINDS, REQUEST_OUTCOMES,
} from './index';

describe('requests (ADR-0051)', () => {
  it('SYS-014: every request is a notification kind, and every way one ends is an outcome', () => {
    for (const kind of REQUEST_KINDS) expect(NOTIFICATION_KINDS).toContain(kind);
    for (const outcomes of Object.values(REQUEST_ENDS)) for (const o of outcomes) expect(REQUEST_OUTCOMES).toContain(o);
    // And no outcome is unused: each is how some request ends.
    expect(new Set(Object.values(REQUEST_ENDS).flat())).toEqual(new Set(REQUEST_OUTCOMES));
  });

  it('SYS-014: the eight requests, and nothing that is news', () => {
    expect([...REQUEST_KINDS].sort()).toEqual([
      'CHECK_IN_AWAITING_AUTHORISATION', 'CLOSING_VARIANCE', 'DISCOUNT_APPROVAL_REQUESTED', 'DISPATCH_REQUESTED',
      'LOST_CLAIM_RAISED', 'SETTLEMENT_SUBMITTED', 'STORE_PENDING_APPROVAL', 'TRANSFER_RECORDED',
    ]);
    expect(isRequestKind('STORE_PENDING_APPROVAL')).toBe(true);
    for (const news of ['STORE_APPROVED', 'TARGET_MISSED', 'CEILING_BREACHED', 'LOAD_ISSUED'] as const) expect(isRequestKind(news)).toBe(false);
  });

  it('SYS-015: only taking a dispatch request is provisional', () => {
    expect(PROVISIONAL_OUTCOMES).toEqual(['TAKEN']);
    expect(REQUEST_ENDS.DISPATCH_REQUESTED).toContain('TAKEN');
  });
});

describe('what waits for a decision (ADR-0051)', () => {
  it('SYS-016: a reader sees the queues they can decide, in order', () => {
    const held = new Set<PermissionCode>(['stores.approve', 'cash.approve_settlement']);
    expect(decisionQueuesFor(held)).toEqual(['STORES', 'SETTLEMENTS', 'TRANSFERS']);
    expect(decisionQueuesFor(new Set())).toEqual([]);
  });

  it('SYS-016: an Admin decides every queue; a seller none', () => {
    expect(decisionQueuesFor(effectivePermissions('ADMIN', new Map()))).toEqual(Object.keys(DECISION_QUEUES));
    expect(decisionQueuesFor(effectivePermissions('SELLER', new Map()))).toEqual([]);
  });
});
