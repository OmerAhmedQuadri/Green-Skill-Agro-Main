import { DomainError } from '../errors';
import { Dec, dec, toMoney, type Money } from '../numeric';
import { businessDate, businessDayStart } from '../time';

/** RET-002, RET-003, OQ-012: why goods come back — not paid for, defective, or never received after a remote confirmation. */
export const RETURN_CONDITIONS = ['UNCLEARED_PAYMENT', 'DEFECTIVE', 'NOT_RECEIVED'] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

/** ADR-0039: a credit note, or — for defective goods only — a like-for-like replacement (RET-010). */
export const RETURN_KINDS = ['CREDIT_NOTE', 'REPLACEMENT'] as const;
export type ReturnKind = (typeof RETURN_KINDS)[number];

/** RET-007: a credited pack goes back into stock on its original batch, or to write-off. */
export const RETURN_OUTCOMES = ['RESTOCK', 'WRITE_OFF'] as const;
export type ReturnOutcome = (typeof RETURN_OUTCOMES)[number];

/** RET-004..006: the Admin's rules — each condition on or off, each with its own window. */
export type ReturnRules = {
  readonly unclearedAllowed: boolean; readonly unclearedWindowDays: number;
  readonly defectiveAllowed: boolean; readonly defectiveWindowDays: number;
};

/** Riyadh calendar days from a sale's completion to now (CONVENTIONS §4). */
export function daysSince(completedAt: Date, now: Date): number {
  const from = businessDayStart(businessDate(completedAt)).getTime();
  return Math.round((businessDayStart(businessDate(now)).getTime() - from) / 86_400_000);
}

export type ConditionState = {
  readonly condition: ReturnCondition;
  readonly windowDays: number;
  /** Whole days left in the window, today included; negative once it has closed. */
  readonly daysLeft: number;
  /** Why it cannot be used now, or null when it can. */
  readonly blockedBy: 'RETURN_CONDITION_DISABLED' | 'RETURN_WINDOW_CLOSED' | 'SALE_ALREADY_PAID' | null;
};

/**
 * RET-002..006: each condition as it stands for a sale now. Payment not yet
 * cleared needs something still owed on the sale (OQ-020); a defect does not
 * depend on payment (RET-003).
 */
export function returnConditions(rules: ReturnRules, sale: { readonly completedAt: Date; readonly unpaid: Money; readonly disputable?: boolean }, now: Date): ConditionState[] {
  const age = daysSince(sale.completedAt, now);
  const state = (condition: ReturnCondition, allowed: boolean, windowDays: number, paid: boolean): ConditionState => ({
    condition, windowDays, daysLeft: windowDays - age,
    blockedBy: !allowed ? 'RETURN_CONDITION_DISABLED' : age > windowDays ? 'RETURN_WINDOW_CLOSED' : paid ? 'SALE_ALREADY_PAID' : null,
  });
  return [
    state('UNCLEARED_PAYMENT', rules.unclearedAllowed, rules.unclearedWindowDays, !dec(sale.unpaid).gt(0)),
    state('DEFECTIVE', rules.defectiveAllowed, rules.defectiveWindowDays, false),
    // OQ-012: only a dispatch the store confirmed on its owner's word can be disputed afterwards.
    ...(sale.disputable ? [state('NOT_RECEIVED', rules.defectiveAllowed, rules.defectiveWindowDays, false)] : []),
  ];
}

/** RET-002..006: refuses a condition that is switched off, out of its window, or — not yet cleared — already paid. */
export function assertReturnAllowed(
  rules: ReturnRules, condition: ReturnCondition, sale: { readonly completedAt: Date; readonly unpaid: Money; readonly disputable?: boolean }, now: Date,
): void {
  const state = returnConditions(rules, sale, now).find((c) => c.condition === condition);
  if (!state) throw new DomainError('RETURN_CONDITION_DISABLED', { condition });
  if (state.blockedBy) throw new DomainError(state.blockedBy, { condition, windowDays: state.windowDays, daysLeft: state.daysLeft });
}

/** RET-010: only a defective item is replaced; anything else comes back on a credit note. */
export function assertReturnKind(kind: ReturnKind, condition: ReturnCondition): void {
  if (kind === 'REPLACEMENT' && condition !== 'DEFECTIVE') throw new DomainError('REPLACEMENT_ONLY_DEFECTIVE', { condition });
}

/** What the store still holds from a sale, per line and batch, in packs (ADR-0039). */
export type HeldBatch = { readonly saleLineId: string; readonly batchId: string; readonly packs: number };
export type ReturnLineInput = { readonly saleLineId: string; readonly batchId: string; readonly packs: number };

/**
 * ADR-0039: sold, less what came back (credit notes and replaced defective
 * packs), plus the replacement batches handed over — so after a replacement a
 * later return still finds the batch the store actually has.
 */
export function heldFromSale(sold: readonly HeldBatch[], returned: readonly HeldBatch[], replacedIn: readonly HeldBatch[]): HeldBatch[] {
  const key = (b: { saleLineId: string; batchId: string }) => `${b.saleLineId}|${b.batchId}`;
  const held = new Map<string, HeldBatch>();
  const add = (b: HeldBatch, sign: 1 | -1) => {
    const now = held.get(key(b));
    held.set(key(b), { saleLineId: b.saleLineId, batchId: b.batchId, packs: (now?.packs ?? 0) + sign * b.packs });
  };
  for (const b of sold) add(b, 1);
  for (const b of replacedIn) add(b, 1);
  for (const b of returned) add(b, -1);
  return [...held.values()].filter((b) => b.packs > 0);
}

/** RET-001: whole packs, something to return, and never more of a batch than the store still holds from this sale. */
export function checkReturnLines(lines: readonly ReturnLineInput[], held: readonly HeldBatch[]): void {
  if (lines.length === 0) throw new DomainError('EMPTY_RETURN');
  const asked = new Map<string, number>();
  for (const l of lines) {
    if (!Number.isInteger(l.packs) || l.packs <= 0) throw new DomainError('INVALID_PACK_COUNT', { saleLineId: l.saleLineId, packs: l.packs });
    const k = `${l.saleLineId}|${l.batchId}`;
    asked.set(k, (asked.get(k) ?? 0) + l.packs);
  }
  for (const [k, packs] of asked) {
    const [saleLineId, batchId] = k.split('|');
    const have = held.find((h) => h.saleLineId === saleLineId && h.batchId === batchId)?.packs ?? 0;
    if (packs > have) throw new DomainError('RETURN_EXCEEDS_HELD', { saleLineId, batchId, packs, held: have });
  }
}

/**
 * ADR-0039: the credit for `packs` more of a line with `credited` already
 * returned — the line's total after discount, pro rata, rounded cumulatively
 * so a line returned in full credits exactly its total.
 */
export function creditFor(line: { readonly total: Money; readonly packs: number }, credited: number, packs: number): Money {
  if (!Number.isInteger(packs) || packs <= 0 || credited < 0 || credited + packs > line.packs) {
    throw new DomainError('RETURN_EXCEEDS_HELD', { packs, credited, sold: line.packs });
  }
  const upTo = (n: number) => dec(toMoney(dec(line.total).times(n).dividedBy(line.packs)));
  return toMoney(upTo(credited + packs).minus(upTo(credited)));
}

/** RET-007: saleable goods go back on their batch; defective, missing, expired or unsaleable ones are written off. */
export function returnOutcome(condition: ReturnCondition, saleable: boolean, batchExpired: boolean): { outcome: ReturnOutcome; writeOffReason: 'DEFECTIVE' | 'EXPIRED' | 'DAMAGED' | 'MISSING' | null } {
  // OQ-012: goods the store says never arrived cannot come back — they are written off where they stand.
  if (condition === 'NOT_RECEIVED') return { outcome: 'WRITE_OFF', writeOffReason: 'MISSING' };
  if (condition === 'DEFECTIVE') return { outcome: 'WRITE_OFF', writeOffReason: 'DEFECTIVE' };
  if (batchExpired) return { outcome: 'WRITE_OFF', writeOffReason: 'EXPIRED' };
  return saleable ? { outcome: 'RESTOCK', writeOffReason: null } : { outcome: 'WRITE_OFF', writeOffReason: 'DAMAGED' };
}

/** Where a credit note's money goes (RET-008, OQ-020), and the part of it that had been collected (COM-009). */
export type CreditSplit = {
  /** Settles what is still owed on this sale. */ readonly toSale: Money;
  /** Settles the store's other debts, oldest first. */ readonly toOtherDebts: Money;
  /** Handed back in cash by the seller. */ readonly refund: Money;
  /** Beyond what was unpaid on the sale — reduces commission in M11. */ readonly collectedPortion: Money;
};

/**
 * RET-008, OQ-020: a credit note settles this sale's unpaid part, then the
 * store's other debts; the rest is a cash refund. Under "payment not yet
 * cleared" it may not exceed what is unpaid on the sale.
 */
export function splitCredit(amount: Money, condition: ReturnCondition, saleUnpaid: Money, otherDebts: Money): CreditSplit {
  const total = dec(amount);
  if (!total.gt(0)) throw new DomainError('INVALID_MONEY', { value: amount });
  if (condition === 'UNCLEARED_PAYMENT' && total.gt(dec(saleUnpaid))) throw new DomainError('RETURN_EXCEEDS_UNPAID', { amount, unpaid: saleUnpaid });
  const toSale = Dec.min(total, dec(saleUnpaid));
  const rest = total.minus(toSale);
  const toOther = Dec.min(rest, dec(otherDebts));
  return { toSale: toMoney(toSale), toOtherDebts: toMoney(toOther), refund: toMoney(rest.minus(toOther)), collectedPortion: toMoney(rest) };
}
