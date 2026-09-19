import { DomainError } from '../errors';

/** DSP-001, STATE-MACHINES §3. */
export const DISPATCH_STATUSES = ['REQUESTED', 'BEING_HANDLED', 'RELEASED', 'DELIVERED', 'CLOSED'] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/** How a closed order ended. */
export const DISPATCH_CLOSE_REASONS = ['DELIVERED', 'CANCELLED', 'LOST'] as const;
export type DispatchCloseReason = (typeof DISPATCH_CLOSE_REASONS)[number];

/** DSP-010: confirmed in person, or on the store owner's word — the latter reviewed at the next vehicle audit. */
export const CONFIRMATION_MODES = ['IN_PERSON', 'OWNER_WORD'] as const;
export type ConfirmationMode = (typeof CONFIRMATION_MODES)[number];

/** DSP-011, DSP-012, OQ-019: how a short delivery is made good. */
export const SHORTFALL_RESOLUTIONS = ['FROM_VEHICLE', 'FURTHER_ORDER', 'NOT_NEEDED'] as const;
export type ShortfallResolution = (typeof SHORTFALL_RESOLUTIONS)[number];

/** DSP-013 */
export const LOST_CLAIM_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type LostClaimStatus = (typeof LOST_CLAIM_STATUSES)[number];

/** DSP-004: every step of an order, with who took it. */
export const DISPATCH_EVENT_TYPES = [
  'RAISED', 'TAKEN', 'RELEASED_BACK', 'RELEASED', 'CONFIRMED', 'RESOLVED', 'CANCELLED', 'CLAIMED', 'CLAIM_APPROVED', 'CLAIM_REJECTED',
] as const;
export type DispatchEventType = (typeof DISPATCH_EVENT_TYPES)[number];

export type DispatchAction = 'take' | 'release_back' | 'release' | 'confirm' | 'resolve' | 'cancel' | 'lose';

const TRANSITIONS: Record<DispatchStatus, Partial<Record<DispatchAction, DispatchStatus>>> = {
  // DSP-005: taking is a label, not a lock — another manager may take it over.
  REQUESTED: { take: 'BEING_HANDLED', release: 'RELEASED', cancel: 'CLOSED' },
  BEING_HANDLED: { take: 'BEING_HANDLED', release_back: 'REQUESTED', release: 'RELEASED', cancel: 'CLOSED' },
  RELEASED: { confirm: 'DELIVERED', lose: 'CLOSED' },
  DELIVERED: { resolve: 'CLOSED' },
  CLOSED: {},
};

/** STATE-MACHINES §3. Once goods have left, the paths are receipt or a lost-order claim — never cancel. */
export function transitionDispatch(from: DispatchStatus, action: DispatchAction): DispatchStatus {
  const to = TRANSITIONS[from][action];
  if (!to) throw new DomainError('INVALID_TRANSITION', { from, action });
  return to;
}

export type DispatchReceiptLine = { readonly lineId: string; readonly released: number; readonly received: number; readonly short: number; readonly damaged: number };

/**
 * DSP-011 (OQ-019): each line's released packs are accounted for exactly —
 * received in good condition, short, or damaged — in whole packs. Returns
 * whether anything is short, so the order waits for its resolution.
 */
export function checkReceipt(lines: readonly DispatchReceiptLine[]): { readonly received: number; readonly shortfall: number } {
  let received = 0;
  let shortfall = 0;
  for (const l of lines) {
    for (const n of [l.received, l.short, l.damaged]) {
      if (!Number.isSafeInteger(n) || n < 0) throw new DomainError('INVALID_PACK_COUNT', { lineId: l.lineId, value: n });
    }
    if (l.received + l.short + l.damaged !== l.released) {
      throw new DomainError('RECEIPT_MISMATCH', { lineId: l.lineId, released: l.released, accounted: l.received + l.short + l.damaged });
    }
    received += l.received;
    shortfall += l.short + l.damaged;
  }
  // Nothing at all arrived is a lost order, not a receipt (DSP-013).
  if (received === 0) throw new DomainError('NOTHING_RECEIVED');
  return { received, shortfall };
}

/** DSP-014: released and still unconfirmed after the configured days — derived when read. */
export function isUnconfirmed(releasedAt: Date | null, now: Date, days: number): boolean {
  return releasedAt !== null && now.getTime() - releasedAt.getTime() > days * 86_400_000;
}
