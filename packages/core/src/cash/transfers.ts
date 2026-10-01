import { DomainError } from '../errors';

/** ADR-0046: what a manager finds when they check a store's bank transfer against the account. */
export const TRANSFER_OUTCOMES = ['CONFIRMED', 'NOT_RECEIVED'] as const;
export type TransferOutcome = (typeof TRANSFER_OUTCOMES)[number];

/**
 * ADR-0046: a store's bank transfer is decided once — confirmed, or found
 * never to have arrived — and by someone other than whoever recorded it (four
 * eyes, as for a settlement). Finding it never arrived has to say why: it puts
 * the money back on the store's balance.
 */
export function assertTransferDecision(input: {
  readonly decided: boolean; readonly recordedBy: string; readonly decidedBy: string;
  readonly outcome: TransferOutcome; readonly reason: string | null;
}): void {
  if (input.decided) throw new DomainError('ALREADY_DECIDED', { entity: 'transfer' });
  if (input.recordedBy === input.decidedBy) throw new DomainError('FOUR_EYES', { entity: 'transfer' });
  if (input.outcome === 'NOT_RECEIVED' && !input.reason?.trim()) throw new DomainError('REASON_REQUIRED', { action: 'not_received' });
}
