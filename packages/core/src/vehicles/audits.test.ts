import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors';
import { assertClosable, auditOutcome, countedPacks, isAuditOverdue, transitionAudit } from './audits';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };
const line = (batchId: string, expectedPacks: number, counted: number | null, comment: string | null = null) =>
  ({ batchId, expectedPacks, countedPacks: counted, comment });

describe('a vehicle audit (workflow N, VEH-011..015, STATE-MACHINES §9)', () => {
  it('VEH-011: counted in whole packs, and a count is compared with the system\'s figure', () => {
    expect(countedPacks(0)).toBe(0);
    expect(code(() => countedPacks(-1))).toBe('INVALID_PACK_COUNT');
    expect(code(() => countedPacks(1.5))).toBe('INVALID_PACK_COUNT');
    expect(auditOutcome(10, 10)).toBe('MATCH');
    expect(auditOutcome(10, 8)).toBe('SHORTFALL');
    expect(auditOutcome(10, 12)).toBe('SURPLUS');
  });

  it('VEH-012: an audit closes only when every batch is counted and every difference explained', () => {
    expect(code(() => assertClosable([line('a', 5, null)]))).toBe('AUDIT_NOT_COUNTED');
    expect(code(() => assertClosable([line('a', 5, 4)]))).toBe('REASON_REQUIRED');
    expect(code(() => assertClosable([line('a', 5, 4, '   ')]))).toBe('REASON_REQUIRED');
    expect(code(() => assertClosable([line('a', 5, 4, 'Two bags split at the store')]))).toBe('NO_ERROR');
    // A line that matches needs no comment.
    expect(code(() => assertClosable([line('a', 5, 5), line('b', 2, 3, 'Found under the seat')]))).toBe('NO_ERROR');
  });

  it('STATE-MACHINES §9: a closed audit is closed for good', () => {
    expect(transitionAudit('IN_PROGRESS')).toBe('CLOSED');
    expect(code(() => transitionAudit('CLOSED'))).toBe('INVALID_TRANSITION');
  });

  it('VEH-015, OQ-022: never audited counts as overdue, and so does one past the Admin\'s interval', () => {
    const now = new Date('2026-09-20T09:00:00+03:00');
    expect(isAuditOverdue(null, now, 30)).toBe(true);
    expect(isAuditOverdue(new Date('2026-09-01T09:00:00+03:00'), now, 30)).toBe(false);
    expect(isAuditOverdue(new Date('2026-08-21T08:59:00+03:00'), now, 30)).toBe(true);
    expect(isAuditOverdue(new Date('2026-09-13T09:00:00+03:00'), now, 7)).toBe(true);
  });
});
