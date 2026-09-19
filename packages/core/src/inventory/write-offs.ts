import { DomainError } from '../errors';

/** WRO-002: why stock is written off. The note gives the detail. */
export const WRITE_OFF_REASONS = ['DAMAGED', 'EXPIRED', 'SPOILED', 'MISSING', 'CONVERSION_LOSS', 'DEFECTIVE', 'OTHER'] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];
/** What a person may choose; the others are recorded by the system. */
export const SUBMITTABLE_REASONS: readonly WriteOffReason[] = ['DAMAGED', 'EXPIRED', 'SPOILED', 'MISSING', 'OTHER'];

export const WRITE_OFF_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED'] as const;
export type WriteOffStatus = (typeof WRITE_OFF_STATUSES)[number];

/**
 * STATE-MACHINES §5: only a submitted write-off is decided, by someone other
 * than its submitter (four-eyes, PERMISSIONS §3.3). Approval may lower the
 * quantity, never raise it; rejection needs a comment (WRO-004).
 */
export function decideWriteOff(
  current: { status: WriteOffStatus; submittedBy: string; requestedPacks: number },
  decision: { approve: boolean; approvedPacks?: number | null | undefined; comment?: string | null | undefined },
  deciderId: string,
): { status: 'APPROVED' | 'REJECTED'; approvedPacks: number | null } {
  if (current.status !== 'SUBMITTED') throw new DomainError('ALREADY_DECIDED', { status: current.status });
  if (current.submittedBy === deciderId) throw new DomainError('FOUR_EYES', { rule: 'SUBMITTER_CANNOT_DECIDE' });
  if (!decision.approve) {
    if (!decision.comment?.trim()) throw new DomainError('REASON_REQUIRED', { action: 'reject' });
    return { status: 'REJECTED', approvedPacks: null };
  }
  const packs = decision.approvedPacks ?? current.requestedPacks;
  if (!Number.isSafeInteger(packs) || packs <= 0 || packs > current.requestedPacks) {
    throw new DomainError('INVALID_PACK_COUNT', { value: packs, max: current.requestedPacks });
  }
  return { status: 'APPROVED', approvedPacks: packs };
}
