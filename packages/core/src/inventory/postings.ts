import { DomainError } from '../errors';
import { Dec, dec, type Quantity } from '../numeric';

/**
 * Stock accounts (DATA-MODEL §1.2). Internal accounts hold real stock;
 * external ones are where stock enters and leaves the business.
 */
export const STOCK_ACCOUNT_KINDS = ['WAREHOUSE', 'VEHICLE', 'DISPATCHED', 'SUPPLIER', 'SOLD', 'WRITTEN_OFF'] as const;
export type StockAccountKind = (typeof STOCK_ACCOUNT_KINDS)[number];
export const INTERNAL_ACCOUNTS: readonly StockAccountKind[] = ['WAREHOUSE', 'VEHICLE', 'DISPATCHED'];
export const isInternal = (kind: StockAccountKind): boolean => INTERNAL_ACCOUNTS.includes(kind);

/** What caused a movement. The ledger is the audit trail for stock (DATA-MODEL §1.1). */
export const STOCK_REFERENCE_TYPES = [
  'GOODS_RECEIPT', 'SKU_CONVERSION', 'WRITE_OFF', 'VEHICLE_LOADOUT', 'VEHICLE_RETURN', 'SALE', 'DISPATCH_ORDER',
  'LOST_ORDER_CLAIM', 'RETURN', 'DEFECTIVE_REPLACEMENT', 'VEHICLE_AUDIT', 'OPENING_BALANCE',
] as const;
export type StockReferenceType = (typeof STOCK_REFERENCE_TYPES)[number];

export type StockAccount =
  | { readonly kind: 'WAREHOUSE'; readonly warehouseId: string }
  | { readonly kind: 'VEHICLE'; readonly vehicleId: string }
  | { readonly kind: 'DISPATCHED' | 'SUPPLIER' | 'SOLD' | 'WRITTEN_OFF' };

export type Leg = {
  readonly batchId: string;
  /** The batch's variety, or its product where the product has no varieties. Conversions balance on it. */
  readonly balanceKey: string;
  readonly account: StockAccount;
  /** Signed, in base units: + into the account, − out of it. */
  readonly quantity: Quantity;
};

/**
 * The balance invariant (DATA-MODEL §3.1): a posting group sums to zero per
 * batch — or, for a conversion, per variety, since the two batches share a
 * base unit (ADR-0015). The database checks the same rule at commit.
 */
export function assertBalanced(legs: readonly Leg[], mode: 'PER_BATCH' | 'PER_VARIETY'): void {
  if (legs.length < 2) throw new DomainError('UNBALANCED_POSTING', { reason: 'TOO_FEW_LEGS' });
  const sums = new Map<string, Dec>();
  for (const leg of legs) {
    const q = dec(leg.quantity);
    if (q.isZero()) throw new DomainError('UNBALANCED_POSTING', { reason: 'ZERO_LEG' });
    const key = mode === 'PER_BATCH' ? leg.batchId : leg.balanceKey;
    sums.set(key, (sums.get(key) ?? new Dec(0)).plus(q));
  }
  for (const [key, sum] of sums) {
    if (!sum.isZero()) throw new DomainError('UNBALANCED_POSTING', { key, sum: sum.toString() });
  }
}

/** A transfer between two accounts: the only shape most operations post (DATA-MODEL §3.1, worked postings). */
export function transfer(batch: { id: string; balanceKey: string }, quantity: Quantity, from: StockAccount, to: StockAccount): Leg[] {
  const q = dec(quantity);
  if (!q.gt(0)) throw new DomainError('INVALID_QUANTITY', { value: quantity });
  return [
    { batchId: batch.id, balanceKey: batch.balanceKey, account: from, quantity: q.negated().toFixed(3) as Quantity },
    { batchId: batch.id, balanceKey: batch.balanceKey, account: to, quantity: q.toFixed(3) as Quantity },
  ];
}

/** Holds are derived, never posted (DATA-MODEL §5.4a): sellable = position − holds, never below zero. */
export function sellable(position: Quantity, holds: readonly Quantity[]): Quantity {
  const free = holds.reduce((acc, h) => acc.minus(dec(h)), dec(position));
  return (free.isNegative() ? new Dec(0) : free).toFixed(3) as Quantity;
}
