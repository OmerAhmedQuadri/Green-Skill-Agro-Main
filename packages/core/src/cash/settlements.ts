import { DomainError } from '../errors';
import { dec, toMoney, type Money } from '../numeric';

/** CSH-002, CSH-003: the two ways cash leaves a seller's hands. */
export const SETTLEMENT_ROUTES = ['BANK_DEPOSIT', 'MANAGER_HANDOVER'] as const;
export type SettlementRoute = (typeof SETTLEMENT_ROUTES)[number];

/** STATE-MACHINES §6. */
export const SETTLEMENT_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export type SettlementAction = 'approve' | 'reject';

/** CSH-004: the first decision stands; a rejected settlement is replaced by a new one, never reopened. */
export function transitionSettlement(from: SettlementStatus, action: SettlementAction): SettlementStatus {
  if (from !== 'SUBMITTED') throw new DomainError('ALREADY_DECIDED', { from, action });
  return action === 'approve' ? 'APPROVED' : 'REJECTED';
}

/** CSH-005: a seller declares no more than the cash the ledger says they hold. */
export function assertDeclarable(declared: Money, cashInHand: Money): void {
  const amount = dec(declared);
  if (!amount.gt(0)) throw new DomainError('INVALID_MONEY', { value: declared });
  if (amount.gt(dec(cashInHand))) throw new DomainError('SETTLEMENT_ABOVE_CASH_IN_HAND', { declared, cashInHand });
}

export type SettlementPostings = {
  /** The cash ledger's `SETTLEMENT_APPROVED` leg — negative (CSH-005). */ readonly settlement: Money;
  /** CSH-006: cash the system had not recorded, posted so the ledger stays honest. Null when there is none. */ readonly discrepancy: Money | null;
  /** CSH-006: declared but not approved — it stays in the seller's hands. Null when there is none. */ readonly shortfall: Money | null;
};

/**
 * CSH-004..006 (ADR-0040): approving moves the approved amount out of the
 * seller's cash in hand. Anything declared but not approved stays with them;
 * anything approved beyond what the ledger knew about is posted as a
 * discrepancy, so cash in hand cannot go negative and nothing is hidden.
 */
export function settlementPostings(declared: Money, approved: Money, cashInHand: Money): SettlementPostings {
  const paid = dec(approved);
  if (!paid.gt(0)) throw new DomainError('INVALID_MONEY', { value: approved });
  const over = paid.minus(dec(cashInHand));
  const short = dec(declared).minus(paid);
  return {
    settlement: toMoney(paid.negated()),
    discrepancy: over.gt(0) ? toMoney(over) : null,
    shortfall: short.gt(0) ? toMoney(short) : null,
  };
}

/** CSH-006: a decision that changes the amount, or refuses it, has to say why. */
export function assertDecisionComment(declared: Money, approved: Money | null, comment: string | null): void {
  const differs = approved === null || !dec(approved).eq(dec(declared));
  if (differs && !comment?.trim()) throw new DomainError('REASON_REQUIRED', { declared, approved });
}

/** LIM-001, OQ-005: what a seller may hold — cash, or the selling value of the stock on their vehicle. */
export const CEILING_KINDS = ['CASH_IN_HAND', 'VEHICLE_STOCK_VALUE'] as const;
export type CeilingKind = (typeof CEILING_KINDS)[number];

/** LIM-002..005: over the ceiling that applies to this seller. No ceiling, no breach. */
export function isOverCeiling(amount: Money, ceiling: Money | null): boolean {
  return ceiling !== null && dec(amount).gt(dec(ceiling));
}

/**
 * LIM-003 (OQ-021): the next reminder is due once the interval has passed.
 * From the second reminder the managers are told as well.
 */
export function reminderDue(lastNotifiedAt: Date, now: Date, intervalHours: number): boolean {
  return now.getTime() - lastNotifiedAt.getTime() >= intervalHours * 3_600_000;
}

export function remindersEscalate(remindersSent: number): boolean {
  return remindersSent >= 1;
}
