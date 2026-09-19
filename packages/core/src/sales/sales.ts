import { DomainError } from '../errors';
import { allocateFefo, type Allocation, type BatchPosition } from '../inventory';
import { Dec, dec, toMoney, type Money, type Percent, type Quantity } from '../numeric';
import { applicableItemCeiling } from '../pricing';
import type { CreditMode, CreditStatus } from '../stores';
import { packCount, type PackCount } from '../units';

/** STATE-MACHINES §2. PENDING_DELIVERY arrives with warehouse dispatch (M7). */
export const SALE_STATUSES = ['PENDING_DISCOUNT_APPROVAL', 'DISCOUNT_APPROVED', 'PENDING_DELIVERY', 'COMPLETED', 'CANCELLED'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

/** DATA-MODEL §5.4a: a sale in these states holds its batches on the vehicle (PRC-011). */
export const HOLDING_SALE_STATUSES = ['PENDING_DISCOUNT_APPROVAL', 'DISCOUNT_APPROVED'] as const satisfies readonly SaleStatus[];

/** Why a sale was cancelled (PRC-014, PRC-015). */
export const SALE_CANCEL_REASONS = ['REJECTED', 'EXPIRED', 'WITHDRAWN'] as const;
export type SaleCancelReason = (typeof SALE_CANCEL_REASONS)[number];

/** PRC-013, PRC-015: where a discount request ended. */
export const DISCOUNT_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REDUCED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'] as const;
export type DiscountRequestStatus = (typeof DISCOUNT_REQUEST_STATUSES)[number];

export type SaleAction = 'approve' | 'reject' | 'expire' | 'withdraw' | 'complete';

const SALE_TRANSITIONS: Record<SaleStatus, Partial<Record<SaleAction, SaleStatus>>> = {
  PENDING_DISCOUNT_APPROVAL: { approve: 'DISCOUNT_APPROVED', reject: 'CANCELLED', expire: 'CANCELLED', withdraw: 'CANCELLED' },
  DISCOUNT_APPROVED: { complete: 'COMPLETED', expire: 'CANCELLED', withdraw: 'CANCELLED' },
  PENDING_DELIVERY: {},
  COMPLETED: {},
  CANCELLED: {},
};

/**
 * STATE-MACHINES §2. A decision on a request someone has already decided —
 * or that expired or was withdrawn meanwhile — is ALREADY_DECIDED: the first
 * decision wins (PRC-012).
 */
export function transitionSale(from: SaleStatus, action: SaleAction): SaleStatus {
  const to = SALE_TRANSITIONS[from][action];
  if (to) return to;
  const deciding = action === 'approve' || action === 'reject';
  throw new DomainError(deciding && from !== 'PENDING_DISCOUNT_APPROVAL' ? 'ALREADY_DECIDED' : 'INVALID_TRANSITION', { from, action });
}

export type SaleLineInput = { readonly skuId: string; readonly packs: number; readonly discount: Percent };
/** PRC-001..006: the price from the store's list, and the SKU's own ceiling or the default item ceiling. */
export type SaleTerms = { readonly unitPrice: Money | null; readonly itemCeiling: Percent };

export type LineAmounts = { readonly gross: Money; readonly discountAmount: Money; readonly total: Money };
export type PricedLine = LineAmounts & {
  readonly skuId: string; readonly packs: PackCount; readonly unitPrice: Money; readonly discount: Percent;
  /** The tighter of the item's and the order's ceiling (PRC-006). */ readonly ceiling: Percent;
  readonly aboveCeiling: boolean;
};
export type PricedSale = {
  readonly lines: readonly PricedLine[]; readonly gross: Money; readonly discount: Money; readonly total: Money;
  /** PRC-008: some line is above its ceiling — the sale can only be requested, not completed. */
  readonly needsApproval: boolean;
};

/** ADR-0037: packs × price, less the discount rounded half-up to the halala. No VAT (OQ-008). */
export function lineAmounts(unitPrice: Money, packs: number, discount: Percent): LineAmounts {
  const gross = dec(unitPrice).times(packs);
  const off = toMoney(gross.times(dec(discount)).dividedBy(100));
  return { gross: toMoney(gross), discountAmount: off, total: toMoney(gross.minus(dec(off))) };
}

export const sumMoney = (values: readonly Money[]): Money => toMoney(values.reduce((s, v) => s.plus(dec(v)), new Dec(0)));

/**
 * SAL-004, SAL-005, PRC-004..009, PRC-016: prices each line, checks each
 * discount against the tighter ceiling and never above the absolute maximum.
 * A line above its ceiling is not an error — it makes the sale one that needs
 * a manager's approval.
 */
export function priceSale(
  lines: readonly SaleLineInput[], terms: ReadonlyMap<string, SaleTerms>, limits: { readonly orderCeiling: Percent; readonly absoluteMaximum: Percent },
): PricedSale {
  if (lines.length === 0) throw new DomainError('EMPTY_SALE');
  const seen = new Set<string>();
  const priced = lines.map((line): PricedLine => {
    if (seen.has(line.skuId)) throw new DomainError('DUPLICATE_LINE', { skuId: line.skuId });
    seen.add(line.skuId);
    const packs = packCount(line.packs);
    if (packs === 0) throw new DomainError('INVALID_PACK_COUNT', { skuId: line.skuId, value: line.packs });
    const term = terms.get(line.skuId);
    if (!term?.unitPrice) throw new DomainError('NO_PRICE', { skuId: line.skuId });
    if (dec(line.discount).gt(dec(limits.absoluteMaximum))) {
      throw new DomainError('DISCOUNT_ABOVE_MAXIMUM', { skuId: line.skuId, absoluteMaximum: limits.absoluteMaximum });
    }
    const ceiling = applicableItemCeiling(limits.orderCeiling, term.itemCeiling);
    return {
      skuId: line.skuId, packs, unitPrice: term.unitPrice, discount: line.discount, ceiling,
      ...lineAmounts(term.unitPrice, packs, line.discount), aboveCeiling: dec(line.discount).gt(dec(ceiling)),
    };
  });
  return {
    lines: priced,
    gross: sumMoney(priced.map((l) => l.gross)), discount: sumMoney(priced.map((l) => l.discountAmount)), total: sumMoney(priced.map((l) => l.total)),
    needsApproval: priced.some((l) => l.aboveCeiling),
  };
}

export type SaleBatch = BatchPosition & { readonly skuId: string };

/**
 * SAL-008, DATA-MODEL §5.4: each line allocated across the vehicle's batches
 * of its SKU, FEFO — binding on a sale; the seller does not pick batches.
 * A vehicle sale cannot sell what is not there (SAL-003).
 */
export function allocateSale(
  lines: readonly { readonly skuId: string; readonly quantity: Quantity }[], batches: readonly SaleBatch[],
): { readonly skuId: string; readonly allocations: readonly Allocation[] }[] {
  return lines.map((line) => {
    const result = allocateFefo(line.quantity, batches.filter((b) => b.skuId === line.skuId));
    if (result.kind === 'SHORTFALL') throw new DomainError('INSUFFICIENT_STOCK', { skuId: line.skuId, shortfall: result.shortfall });
    return { skuId: line.skuId, allocations: result.allocations };
  });
}

export type ApprovalLine = { readonly id: string; readonly requested: Percent };
export type DiscountDecision =
  | { readonly outcome: 'APPROVED' | 'REDUCED'; readonly discounts: ReadonlyMap<string, Percent> }
  | { readonly outcome: 'REJECTED' };

/**
 * PRC-013 (ADR-0037): approve as requested, approve lower — any line, never
 * higher than asked — or reject. Lowering or rejecting needs a comment.
 */
export function decideDiscount(
  lines: readonly ApprovalLine[], input: { readonly approve: boolean; readonly discounts?: ReadonlyMap<string, Percent> | undefined; readonly comment?: string | null | undefined },
): DiscountDecision {
  const comment = input.comment?.trim() ?? '';
  if (!input.approve) {
    if (!comment) throw new DomainError('REASON_REQUIRED', { action: 'reject' });
    return { outcome: 'REJECTED' };
  }
  const known = new Set(lines.map((l) => l.id));
  for (const id of input.discounts?.keys() ?? []) if (!known.has(id)) throw new DomainError('NOT_FOUND', { entity: 'sale_line', id });
  let reduced = false;
  const discounts = new Map(lines.map((l) => {
    const given = input.discounts?.get(l.id) ?? l.requested;
    if (dec(given).gt(dec(l.requested))) throw new DomainError('DISCOUNT_RAISED', { lineId: l.id, requested: l.requested });
    if (dec(given).lt(dec(l.requested))) reduced = true;
    return [l.id, given] as const;
  }));
  if (reduced && !comment) throw new DomainError('REASON_REQUIRED', { action: 'reduce' });
  return { outcome: reduced ? 'REDUCED' : 'APPROVED', discounts };
}

/**
 * SAL-001, SAL-002, SAL-009, CRD-004..007, OQ-018: whether this store can take
 * this sale. A store not approved, rejected or inactive — never. Blocked on
 * credit, or a sale on credit above what is available — only with a manager's
 * same-day override, which the sale then uses up. Bill to bill settles in
 * full at once, so the limit does not apply to it (SAL-006).
 */
export function assertSaleCredit(credit: CreditStatus, mode: CreditMode, total: Money): { readonly usesOverride: boolean } {
  const store = credit.reasons.filter((r) => r.code === 'NOT_APPROVED' || r.code === 'REJECTED' || r.code === 'INACTIVE');
  if (store.length > 0) throw new DomainError('STORE_NOT_ACTIVE', { reasons: store });
  const blocked = credit.reasons.length > 0;
  const overLimit = mode !== 'BILL_TO_BILL' && dec(credit.outstanding).plus(dec(total)).gt(dec(credit.limit));
  if (!blocked && !overLimit) return { usesOverride: false };
  if (!credit.overrideAvailable) {
    if (blocked) throw new DomainError('CREDIT_BLOCKED', { reasons: credit.reasons });
    throw new DomainError('CREDIT_LIMIT_EXCEEDED', { available: credit.available, total });
  }
  return { usesOverride: true };
}
