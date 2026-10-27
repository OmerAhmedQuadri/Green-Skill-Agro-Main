import { DomainError } from '../errors';

/**
 * Correcting history (M13, ADR-0059): only a Super Admin, only inside a personal correction session opened with
 * their password and a reason. With no session open, nobody can correct anything. Mirror packages/db.
 */

/** COR-001: a session ends an hour after it opens, unless it is closed sooner. */
export const CORRECTION_SESSION_MS = 60 * 60 * 1000;

/** COR-003: how the session's reason was settled when it closed. EDITED keeps the original, shown struck through. */
export const CORRECTION_CLOSINGS = ['KEPT', 'ADDED', 'EDITED'] as const;
export type CorrectionClosing = (typeof CORRECTION_CLOSINGS)[number];

/**
 * OPEN   — corrections may be made in it
 * ENDED  — its hour ran out; it waits for its owner to settle the reason, and no correction may be made
 * CLOSED — its reason settled
 */
export type CorrectionSessionState = 'OPEN' | 'ENDED' | 'CLOSED';

export function correctionSessionEnds(openedAt: Date): Date {
  return new Date(openedAt.getTime() + CORRECTION_SESSION_MS);
}

export function correctionSessionState(session: { endsAt: Date; closedAt: Date | null }, now: Date): CorrectionSessionState {
  if (session.closedAt) return 'CLOSED';
  return now < session.endsAt ? 'OPEN' : 'ENDED';
}

/** When a session stopped: when it was closed, or at the end of its hour if it ran out first. */
export function correctionSessionEndedAt(session: { endsAt: Date }, closedAt: Date): Date {
  return closedAt < session.endsAt ? closedAt : session.endsAt;
}

/** COR-001, COR-002: a reason is required, kept as written without its outer spaces. */
export function correctionReason(value: string | null | undefined, field = 'reason'): string {
  const reason = value?.trim() ?? '';
  if (!reason) throw new DomainError('REASON_REQUIRED', { field });
  return reason;
}

/**
 * COR-003: settling the reason at closing. Adding or editing needs the new words; an "edit" that changes nothing
 * keeps the reason.
 */
export function settleCorrectionReason(
  reason: string, closing: CorrectionClosing, text: string | null | undefined,
): { closing: CorrectionClosing; text: string | null } {
  if (closing === 'KEPT') return { closing, text: null };
  const words = correctionReason(text, 'closingText');
  if (closing === 'EDITED' && words === reason) return { closing: 'KEPT', text: null };
  return { closing, text: words };
}
