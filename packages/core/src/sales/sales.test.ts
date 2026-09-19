import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors';
import type { Money, Percent, Quantity } from '../numeric';
import { creditStatus } from '../stores/credit';
import { allocateSale, assertSaleCredit, decideDiscount, lineAmounts, priceSale, transitionSale, type SaleTerms } from './sales';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };
const m = (v: string) => v as Money;
const p = (v: string) => v as Percent;
const q = (v: string) => v as Quantity;

const terms = new Map<string, SaleTerms>([
  ['bag', { unitPrice: m('90.00'), itemCeiling: p('5') }],
  ['pouch', { unitPrice: m('19.99'), itemCeiling: p('15') }],
  ['unpriced', { unitPrice: null, itemCeiling: p('5') }],
]);
const limits = { orderCeiling: p('10'), absoluteMaximum: p('25') };

describe('pricing a sale (SAL-004, SAL-005, PRC-004..009, PRC-016)', () => {
  it('SAL-004: packs × the store price, less the discount rounded half-up to the halala; no VAT (DOC-006)', () => {
    expect(lineAmounts(m('19.99'), 3, p('7.5'))).toEqual({ gross: '59.97', discountAmount: '4.50', total: '55.47' });
    const sale = priceSale([{ skuId: 'bag', packs: 2, discount: p('0') }, { skuId: 'pouch', packs: 3, discount: p('7.5') }], terms, limits);
    expect(sale).toMatchObject({ gross: '239.97', discount: '4.50', total: '235.47', needsApproval: false });
  });

  it('PRC-006, SAL-005: the tighter of the item and order ceiling governs — 5% on the bag, 10% (not 15%) on the pouch', () => {
    const within = priceSale([{ skuId: 'bag', packs: 1, discount: p('5') }, { skuId: 'pouch', packs: 1, discount: p('10') }], terms, limits);
    expect(within.lines.map((l) => l.ceiling)).toEqual(['5', '10']);
    expect(within.needsApproval).toBe(false);
    const above = priceSale([{ skuId: 'bag', packs: 1, discount: p('6') }, { skuId: 'pouch', packs: 1, discount: p('10') }], terms, limits);
    expect(above.lines.map((l) => l.aboveCeiling)).toEqual([true, false]);
    expect(above.needsApproval).toBe(true);
    expect(priceSale([{ skuId: 'pouch', packs: 1, discount: p('12') }], terms, limits).needsApproval).toBe(true);
  });

  it('PRC-016: nothing above the absolute maximum can even be requested', () => {
    expect(code(() => priceSale([{ skuId: 'bag', packs: 1, discount: p('25') }], terms, limits))).toBe('NO_ERROR');
    expect(code(() => priceSale([{ skuId: 'bag', packs: 1, discount: p('25.001') }], terms, limits))).toBe('DISCOUNT_ABOVE_MAXIMUM');
  });

  it('STK-015, SAL-004: whole packs only, one line per SKU, and only priced SKUs', () => {
    expect(code(() => priceSale([], terms, limits))).toBe('EMPTY_SALE');
    expect(code(() => priceSale([{ skuId: 'bag', packs: 1.5, discount: p('0') }], terms, limits))).toBe('INVALID_PACK_COUNT');
    expect(code(() => priceSale([{ skuId: 'bag', packs: 0, discount: p('0') }], terms, limits))).toBe('INVALID_PACK_COUNT');
    expect(code(() => priceSale([{ skuId: 'bag', packs: 1, discount: p('0') }, { skuId: 'bag', packs: 1, discount: p('0') }], terms, limits))).toBe('DUPLICATE_LINE');
    expect(code(() => priceSale([{ skuId: 'unpriced', packs: 1, discount: p('0') }], terms, limits))).toBe('NO_PRICE');
    expect(code(() => priceSale([{ skuId: 'nowhere', packs: 1, discount: p('0') }], terms, limits))).toBe('NO_PRICE');
  });
});

describe('allocating a sale (SAL-008, DATA-MODEL §5.4)', () => {
  const batch = (batchId: string, skuId: string, available: string, expiresOn: string | null) =>
    ({ batchId, skuId, available: q(available), expiresOn, receivedAt: new Date('2026-01-01'), flagged: false });

  it('SAL-008: each line takes its own SKU’s batches, earliest expiry first, across batches when needed', () => {
    const out = allocateSale(
      [{ skuId: 'bag', quantity: q('15000.000') }, { skuId: 'pouch', quantity: q('1000.000') }],
      [batch('late', 'bag', '10000.000', '2028-01-01'), batch('early', 'bag', '10000.000', '2027-01-01'), batch('p1', 'pouch', '5000.000', null)],
    );
    expect(out).toEqual([
      { skuId: 'bag', allocations: [{ batchId: 'early', quantity: '10000.000' }, { batchId: 'late', quantity: '5000.000' }] },
      { skuId: 'pouch', allocations: [{ batchId: 'p1', quantity: '1000.000' }] },
    ]);
  });

  it('SAL-003: a vehicle sale cannot sell more than the vehicle holds', () => {
    expect(code(() => allocateSale([{ skuId: 'bag', quantity: q('20000.000') }], [batch('b', 'bag', '15000.000', null)]))).toBe('INSUFFICIENT_STOCK');
  });
});

describe('the sale lifecycle (STATE-MACHINES §2)', () => {
  it('PRC-012, PRC-014, PRC-015: pending → approved → completed; rejection, expiry and withdrawal cancel', () => {
    expect(transitionSale('PENDING_DISCOUNT_APPROVAL', 'approve')).toBe('DISCOUNT_APPROVED');
    expect(transitionSale('DISCOUNT_APPROVED', 'complete')).toBe('COMPLETED');
    for (const a of ['reject', 'expire', 'withdraw'] as const) expect(transitionSale('PENDING_DISCOUNT_APPROVAL', a)).toBe('CANCELLED');
    expect(transitionSale('DISCOUNT_APPROVED', 'withdraw')).toBe('CANCELLED');
    expect(transitionSale('DISCOUNT_APPROVED', 'expire')).toBe('CANCELLED');
  });

  it('PRC-010, PRC-012: a pending sale cannot complete; the first decision wins', () => {
    expect(code(() => transitionSale('PENDING_DISCOUNT_APPROVAL', 'complete'))).toBe('INVALID_TRANSITION');
    expect(code(() => transitionSale('DISCOUNT_APPROVED', 'approve'))).toBe('ALREADY_DECIDED');
    expect(code(() => transitionSale('CANCELLED', 'reject'))).toBe('ALREADY_DECIDED');
    expect(code(() => transitionSale('COMPLETED', 'withdraw'))).toBe('INVALID_TRANSITION');
  });
});

describe('deciding a discount request (PRC-013)', () => {
  const lines = [{ id: 'a', requested: p('12') }, { id: 'b', requested: p('3') }];

  it('PRC-013: approve as requested — a comment is optional', () => {
    const d = decideDiscount(lines, { approve: true });
    expect(d.outcome).toBe('APPROVED');
    expect(d.outcome !== 'REJECTED' && [...d.discounts.values()]).toEqual(['12', '3']);
  });

  it('PRC-013: approve lower, with a comment — never higher than asked', () => {
    const d = decideDiscount(lines, { approve: true, discounts: new Map([['a', p('8')]]), comment: 'Eight is the most this season' });
    expect(d.outcome).toBe('REDUCED');
    expect(d.outcome !== 'REJECTED' && d.discounts.get('a')).toBe('8');
    expect(code(() => decideDiscount(lines, { approve: true, discounts: new Map([['a', p('8')]]) }))).toBe('REASON_REQUIRED');
    expect(code(() => decideDiscount(lines, { approve: true, discounts: new Map([['a', p('13')]]), comment: 'x' }))).toBe('DISCOUNT_RAISED');
    expect(code(() => decideDiscount(lines, { approve: true, discounts: new Map([['z', p('1')]]), comment: 'x' }))).toBe('NOT_FOUND');
  });

  it('PRC-013: a rejection needs a comment', () => {
    expect(code(() => decideDiscount(lines, { approve: false, comment: ' ' }))).toBe('REASON_REQUIRED');
    expect(decideDiscount(lines, { approve: false, comment: 'Too deep' }).outcome).toBe('REJECTED');
  });
});

describe('credit at the point of sale (SAL-001, SAL-002, SAL-009, CRD-004..007, OQ-018)', () => {
  const status = (over: { open?: string; dueOn?: string; limit?: string; override?: boolean; store?: 'ACTIVE' | 'INACTIVE' } = {}) => creditStatus({
    status: over.store ?? 'ACTIVE', limit: m(over.limit ?? '5000.00'), graceDays: 0, today: '2026-09-19', overrideActive: over.override ?? false,
    openDebits: over.open ? [{ dueOn: over.dueOn ?? '2026-09-26', open: m(over.open) }] : [],
  });

  it('OQ-018: a sale on credit stops at the limit — 500 available cannot take 2,000', () => {
    expect(assertSaleCredit(status({ open: '4500.00' }), 'WEEKLY', m('500.00'))).toEqual({ usesOverride: false });
    expect(code(() => assertSaleCredit(status({ open: '4500.00' }), 'WEEKLY', m('2000.00')))).toBe('CREDIT_LIMIT_EXCEEDED');
  });

  it('SAL-006: bill to bill settles at once, so the limit does not apply', () => {
    expect(assertSaleCredit(status({ limit: '0.00' }), 'BILL_TO_BILL', m('2000.00'))).toEqual({ usesOverride: false });
  });

  it('SAL-002, CRD-004: a store past due is blocked with its reasons', () => {
    expect(code(() => assertSaleCredit(status({ open: '100.00', dueOn: '2026-09-12' }), 'WEEKLY', m('10.00')))).toBe('CREDIT_BLOCKED');
  });

  it('SAL-009, CRD-006: a same-day override releases a block or the limit for the one sale that uses it', () => {
    expect(assertSaleCredit(status({ open: '100.00', dueOn: '2026-09-12', override: true }), 'WEEKLY', m('10.00'))).toEqual({ usesOverride: true });
    expect(assertSaleCredit(status({ open: '4500.00', override: true }), 'WEEKLY', m('2000.00'))).toEqual({ usesOverride: true });
    expect(assertSaleCredit(status({ override: true }), 'WEEKLY', m('10.00'))).toEqual({ usesOverride: false });
  });

  it('STO-009: an inactive store cannot be sold to, override or not', () => {
    expect(code(() => assertSaleCredit(status({ store: 'INACTIVE', override: true }), 'WEEKLY', m('10.00')))).toBe('STORE_NOT_ACTIVE');
  });
});
