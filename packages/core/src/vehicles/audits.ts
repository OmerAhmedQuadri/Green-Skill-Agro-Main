import { DomainError } from '../errors';

/** STATE-MACHINES §9: a count in progress, then closed for good. */
export const AUDIT_STATUSES = ['IN_PROGRESS', 'CLOSED'] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

/** VEH-011: how a counted line compares with the system's figure. */
export const AUDIT_OUTCOMES = ['MATCH', 'SHORTFALL', 'SURPLUS'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** OQ-022: stock found over the system's figure is added only once a manager approves. */
export const SURPLUS_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type SurplusStatus = (typeof SURPLUS_STATUSES)[number];

export function transitionAudit(from: AuditStatus): AuditStatus {
  if (from !== 'IN_PROGRESS') throw new DomainError('INVALID_TRANSITION', { from, action: 'close' });
  return 'CLOSED';
}

/** VEH-011: whole packs, never negative — a batch nobody counted is not the same as one counted as zero. */
export function countedPacks(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new DomainError('INVALID_PACK_COUNT', { value });
  return value;
}

export function auditOutcome(expectedPacks: number, counted: number): AuditOutcome {
  if (counted === expectedPacks) return 'MATCH';
  return counted < expectedPacks ? 'SHORTFALL' : 'SURPLUS';
}

export type AuditLineState = {
  readonly batchId: string; readonly expectedPacks: number;
  readonly countedPacks: number | null; readonly comment: string | null;
};

/**
 * VEH-012 (STATE-MACHINES §9): an audit closes only when every batch has been
 * counted and every difference has been explained. Nothing is adjusted
 * silently in either direction.
 */
export function assertClosable(lines: readonly AuditLineState[]): void {
  const uncounted = lines.filter((l) => l.countedPacks === null).map((l) => l.batchId);
  if (uncounted.length > 0) throw new DomainError('AUDIT_NOT_COUNTED', { batches: uncounted });
  const unexplained = lines
    .filter((l) => l.countedPacks !== null && auditOutcome(l.expectedPacks, l.countedPacks) !== 'MATCH' && !l.comment?.trim())
    .map((l) => l.batchId);
  if (unexplained.length > 0) throw new DomainError('REASON_REQUIRED', { batches: unexplained });
}

/** VEH-015, OQ-022: never audited, or last audited longer ago than the Admin's interval. */
export function isAuditOverdue(lastClosedAt: Date | null, now: Date, intervalDays: number): boolean {
  if (!lastClosedAt) return true;
  return now.getTime() - lastClosedAt.getTime() >= intervalDays * 86_400_000;
}
