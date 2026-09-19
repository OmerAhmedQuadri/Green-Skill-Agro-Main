import { Dec, dec, type Quantity } from '../numeric';

export type BatchPosition = {
  readonly batchId: string;
  /** Null for a product type with expiry disabled: such batches go last (CAT-016). */
  readonly expiresOn: string | null;
  readonly receivedAt: Date;
  /** What can be taken from this location now: position less holds. */
  readonly available: Quantity;
  /** EXP-006: a flagged batch is proposed before any other. */
  readonly flagged: boolean;
};

export type Allocation = { readonly batchId: string; readonly quantity: Quantity };
export type AllocationResult =
  | { readonly kind: 'ALLOCATED'; readonly allocations: readonly Allocation[] }
  | { readonly kind: 'SHORTFALL'; readonly allocations: readonly Allocation[]; readonly shortfall: Quantity };

/** EXP-006, DATA-MODEL §5.4: flagged first, then earliest expiry, no expiry last, then oldest receipt. */
export function fefoOrder(batches: readonly BatchPosition[]): BatchPosition[] {
  return [...batches].sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    if (a.expiresOn !== b.expiresOn) {
      if (a.expiresOn === null) return 1;
      if (b.expiresOn === null) return -1;
      return a.expiresOn < b.expiresOn ? -1 : 1;
    }
    return a.receivedAt.getTime() - b.receivedAt.getTime();
  });
}

/**
 * Takes a quantity from batches in FEFO order. Total, never throwing: a
 * shortfall is a normal outcome — it is what turns a sale into a dispatch
 * request (SAL-003). Advisory when issuing to a vehicle, binding on a sale.
 */
export function allocateFefo(demand: Quantity, batches: readonly BatchPosition[]): AllocationResult {
  let remaining = dec(demand);
  const allocations: Allocation[] = [];
  for (const b of fefoOrder(batches)) {
    if (!remaining.gt(0)) break;
    const available = dec(b.available);
    if (!available.gt(0)) continue;
    const take = Dec.min(available, remaining);
    allocations.push({ batchId: b.batchId, quantity: take.toFixed(3) as Quantity });
    remaining = remaining.minus(take);
  }
  return remaining.gt(0)
    ? { kind: 'SHORTFALL', allocations, shortfall: remaining.toFixed(3) as Quantity }
    : { kind: 'ALLOCATED', allocations };
}
