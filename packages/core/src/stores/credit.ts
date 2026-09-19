import { DomainError } from '../errors';
import { Dec, dec, toMoney, type Money } from '../numeric';
import { nextBusinessDate } from '../time';

/** CRD-001: how a store settles. */
export const CREDIT_MODES = ['BILL_TO_BILL', 'WEEKLY', 'MONTHLY', 'CUSTOM'] as const;
export type CreditMode = (typeof CREDIT_MODES)[number];

/** OQ-018: the day a weekly cycle closes is an Admin setting — Saturday unless changed. */
export const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function assertCreditTerms(mode: CreditMode, customDays: number | null | undefined, available: ReadonlySet<CreditMode>): number | null {
  if (!available.has(mode)) throw new DomainError('CREDIT_MODE_UNAVAILABLE', { mode });
  if (mode !== 'CUSTOM') return null;
  if (!Number.isSafeInteger(customDays) || (customDays ?? 0) < 1 || (customDays ?? 0) > 365) {
    throw new DomainError('CREDIT_MODE_UNAVAILABLE', { mode, field: 'customDays' });
  }
  return customDays ?? null;
}

const addDays = (date: string, days: number) => {
  let d = date;
  for (let i = 0; i < days; i += 1) d = nextBusinessDate(d);
  return d;
};

/**
 * OQ-018, ADR-0036: when a debit posted on `postedOn` (a Riyadh business date)
 * falls due. Bill to bill — the same day; weekly — the next closing day, that
 * day itself included (Saturday unless the Admin changes it); monthly — the
 * month's last day; custom — N days on. Fixed at posting: a later change of
 * cycle or closing day never moves it.
 */
export function dueDateFor(mode: CreditMode, customDays: number | null, postedOn: string, weekClosesOn: Weekday = 'SATURDAY'): string {
  switch (mode) {
    case 'BILL_TO_BILL': return postedOn;
    case 'WEEKLY': {
      const weekday = new Date(`${postedOn}T00:00:00Z`).getUTCDay(); // 0 Sunday … 6 Saturday
      return addDays(postedOn, (WEEKDAYS.indexOf(weekClosesOn) - weekday + 7) % 7);
    }
    case 'MONTHLY': {
      const [y, m] = postedOn.split('-').map(Number) as [number, number];
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return `${postedOn.slice(0, 8)}${String(last).padStart(2, '0')}`;
    }
    case 'CUSTOM': return addDays(postedOn, customDays ?? 0);
  }
}

export type OpenDebit = { readonly id: string; readonly dueOn: string; readonly occurredAt: Date; readonly open: Money };
export type CreditAllocation = { readonly debitId: string; readonly amount: Money };

/**
 * CRD-003: a payment — or a credit adjustment — settles the oldest due debts
 * first; partial payments leave the rest carrying forward. It cannot exceed
 * what is owed (ADR-0036: no credit balances in Phase 1).
 */
export function allocateCredit(amount: Money, debits: readonly OpenDebit[]): CreditAllocation[] {
  let left = dec(amount);
  if (!left.gt(0)) throw new DomainError('INVALID_MONEY', { value: amount });
  const owed = debits.reduce((sum, d) => sum.plus(dec(d.open)), new Dec(0));
  if (left.gt(owed)) throw new DomainError('PAYMENT_EXCEEDS_BALANCE', { amount, owed: toMoney(owed) });
  const ordered = [...debits].sort((a, b) => (a.dueOn === b.dueOn ? a.occurredAt.getTime() - b.occurredAt.getTime() : a.dueOn < b.dueOn ? -1 : 1));
  const out: CreditAllocation[] = [];
  for (const d of ordered) {
    if (!left.gt(0)) break;
    const take = Dec.min(left, dec(d.open));
    if (take.gt(0)) out.push({ debitId: d.id, amount: toMoney(take) });
    left = left.minus(take);
  }
  return out;
}

export type BlockReason =
  | { readonly code: 'NOT_APPROVED' } | { readonly code: 'REJECTED' } | { readonly code: 'INACTIVE' }
  | { readonly code: 'PAST_DUE'; readonly amount: Money; readonly oldestDueOn: string }
  | { readonly code: 'OVER_LIMIT'; readonly outstanding: Money; readonly limit: Money };

export type CreditStatus = {
  readonly outstanding: Money; readonly pastDue: Money; readonly limit: Money; readonly available: Money;
  readonly blocked: boolean; readonly reasons: readonly BlockReason[]; readonly overridden: boolean;
  /** An unused same-day override: it releases the next sale from a credit block or the limit (OQ-018). */
  readonly overrideAvailable: boolean;
};

/**
 * CRD-004, CRD-005 (STATE-MACHINES §4): derived at the point of sale, never
 * stored. Past due — any debt whose due date plus the grace days is behind
 * today; over the limit — owing more than the limit (0 means no credit). A
 * same-day override lifts a credit block for one sale; it never lifts a store
 * that is not approved, rejected or inactive.
 */
export function creditStatus(input: {
  status: 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'INACTIVE';
  limit: Money; openDebits: readonly { dueOn: string; open: Money }[]; graceDays: number; today: string; overrideActive: boolean;
}): CreditStatus {
  const outstanding = input.openDebits.reduce((sum, d) => sum.plus(dec(d.open)), new Dec(0));
  const pastDueDebits = input.openDebits.filter((d) => dec(d.open).gt(0) && addDays(d.dueOn, input.graceDays) < input.today);
  const pastDue = pastDueDebits.reduce((sum, d) => sum.plus(dec(d.open)), new Dec(0));
  const reasons: BlockReason[] = [];
  if (input.status === 'PENDING_APPROVAL') reasons.push({ code: 'NOT_APPROVED' });
  if (input.status === 'REJECTED') reasons.push({ code: 'REJECTED' });
  if (input.status === 'INACTIVE') reasons.push({ code: 'INACTIVE' });
  const creditReasons: BlockReason[] = [];
  if (pastDue.gt(0)) {
    const oldest = pastDueDebits.map((d) => d.dueOn).sort()[0] ?? input.today;
    creditReasons.push({ code: 'PAST_DUE', amount: toMoney(pastDue), oldestDueOn: oldest });
  }
  if (outstanding.gt(dec(input.limit))) creditReasons.push({ code: 'OVER_LIMIT', outstanding: toMoney(outstanding), limit: input.limit });
  const overridden = input.overrideActive && creditReasons.length > 0 && reasons.length === 0;
  const all = overridden ? reasons : [...reasons, ...creditReasons];
  const available = dec(input.limit).minus(outstanding);
  return {
    outstanding: toMoney(outstanding), pastDue: toMoney(pastDue), limit: input.limit, available: toMoney(available.gt(0) ? available : new Dec(0)),
    blocked: all.length > 0, reasons: [...reasons, ...creditReasons], overridden, overrideAvailable: input.overrideActive && reasons.length === 0,
  };
}
