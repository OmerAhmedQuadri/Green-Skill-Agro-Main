import { DomainError } from '../errors';
import { dec, toMoney, type Money } from '../numeric';

export const VEHICLE_STATUSES = ['ACTIVE', 'MAINTENANCE', 'RETIRED'] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

/**
 * VEH-001: a registration as written on the plate — Latin or Arabic letters,
 * digits, spaces and hyphens. Spaces are collapsed and Latin letters upper-cased,
 * so "abc  1234" and "ABC 1234" are the same vehicle.
 */
export function normaliseRegistration(raw: string): string {
  const value = raw.normalize('NFC').trim().replace(/\s+/g, ' ').toUpperCase();
  if (value.length < 2 || value.length > 20 || !/^[\p{L}\p{N}][\p{L}\p{N} -]*$/u.test(value)) {
    throw new DomainError('INVALID_REGISTRATION', { value: raw });
  }
  return value;
}

/** VEH-001, VEH-004: a reading in whole kilometres. */
export function odometerReading(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9_999_999) throw new DomainError('INVALID_ODOMETER', { value });
  return value;
}

// ---------------------------------------------------------------- loads (STATE-MACHINES §7)

export const LOAD_STATUSES = ['ISSUED', 'CONFIRMED', 'DISPUTED', 'CANCELLED'] as const;
export type LoadStatus = (typeof LOAD_STATUSES)[number];
export type LoadAction = 'confirm' | 'dispute' | 'amend' | 'cancel';

const LOAD_RULES: Record<LoadAction, { from: readonly LoadStatus[]; to: LoadStatus }> = {
  confirm: { from: ['ISSUED'], to: 'CONFIRMED' },
  dispute: { from: ['ISSUED'], to: 'DISPUTED' },
  amend: { from: ['ISSUED', 'DISPUTED'], to: 'ISSUED' },
  cancel: { from: ['ISSUED', 'DISPUTED'], to: 'CANCELLED' },
};

/** Loads still waiting on the seller hold their warehouse stock (DATA-MODEL §5.4a). */
export const HOLDING_LOAD_STATUSES: readonly LoadStatus[] = ['ISSUED', 'DISPUTED'];

/** The only way a vehicle load changes state. A seller's dispute needs a comment. */
export function transitionLoad(status: LoadStatus, action: LoadAction, comment?: string | null): LoadStatus {
  const rule = LOAD_RULES[action];
  if (!rule.from.includes(status)) {
    throw new DomainError(status === 'CONFIRMED' || status === 'CANCELLED' ? 'ALREADY_DECIDED' : 'INVALID_TRANSITION', { status, action });
  }
  if ((action === 'dispute' || action === 'cancel') && !comment?.trim()) throw new DomainError('REASON_REQUIRED', { action });
  return rule.to;
}

/**
 * VEH-006, OQ-005: the vehicle's stock value plus the load, against the
 * seller's effective ceiling. A breach is a warning the manager acknowledges —
 * never a block (LIM-005). No ceiling set: no breach.
 */
export function ceilingCheck(input: { current: Money; load: Money; ceiling: Money | null }): {
  projected: Money; ceiling: Money | null; breach: boolean; excess: Money;
} {
  const projected = dec(input.current).plus(dec(input.load));
  const excess = input.ceiling === null ? dec('0') : projected.minus(dec(input.ceiling));
  return { projected: toMoney(projected), ceiling: input.ceiling, breach: excess.gt(0), excess: toMoney(excess.gt(0) ? excess : dec('0')) };
}

// ---------------------------------------------------------------- handovers (STATE-MACHINES §8)

export const HANDOVER_STATUSES = ['PROPOSED', 'CONFIRMED', 'CANCELLED'] as const;
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];

/**
 * VEH-009: the outgoing and the incoming seller each confirm; the second
 * confirmation completes the handover. Anyone else is not a party to it.
 */
export function confirmHandoverBy(
  h: { status: HandoverStatus; outgoingSellerId: string; incomingSellerId: string; outgoingConfirmedAt: Date | null; incomingConfirmedAt: Date | null },
  userId: string,
): { side: 'OUTGOING' | 'INCOMING'; complete: boolean } {
  if (h.status !== 'PROPOSED') throw new DomainError('ALREADY_DECIDED', { status: h.status });
  const side = userId === h.outgoingSellerId ? 'OUTGOING' : userId === h.incomingSellerId ? 'INCOMING' : null;
  if (!side) throw new DomainError('NOT_FOUND', { entity: 'vehicle_handover' });
  const already = side === 'OUTGOING' ? h.outgoingConfirmedAt : h.incomingConfirmedAt;
  if (already) throw new DomainError('ALREADY_DECIDED', { side });
  const other = side === 'OUTGOING' ? h.incomingConfirmedAt : h.outgoingConfirmedAt;
  return { side, complete: other !== null };
}

// ---------------------------------------------------------------- returns (STK-012)

/** STK-012: why stock comes back from a vehicle to the warehouse. */
export const VEHICLE_RETURN_REASONS = [
  'EXPIRY_RECALL', 'REDISTRIBUTION', 'SELLER_LEAVING', 'STORE_RETURN', 'VEHICLE_WITHDRAWN', 'MANAGER_RECALL',
] as const;
export type VehicleReturnReason = (typeof VEHICLE_RETURN_REASONS)[number];
