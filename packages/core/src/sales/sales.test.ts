import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors';
import type { Money, Percent, Quantity } from '../numeric';
import { creditStatus } from '../stores/credit';
import {
  allocateSale, assertPaidInFull, assertSaleCredit, decideDiscount, lineAmounts, openSaleGrounds, priceSale, transitionSale, type SaleTerms,
} from './sales';

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
  const status = (over: {
    open?: string; dueOn?: string; limit?: string; override?: boolean; store?: 'ACTIVE' | 'INACTIVE'; mode?: 'WEEKLY' | 'BILL_TO_BILL'; committed?: string;
  } = {}) => creditStatus({
    status: over.store ?? 'ACTIVE', mode: over.mode ?? 'WEEKLY', limit: m(over.limit ?? '5000.00'), graceDays: 0, today: '2026-09-19',
    overrideActive: over.override ?? false, committed: m(over.committed ?? '0.00'),
    openDebits: over.open ? [{ dueOn: over.dueOn ?? '2026-09-26', open: m(over.open) }] : [],
  });

  it('OQ-018: a sale on credit stops at the limit — 500 available cannot take 2,000', () => {
    expect(assertSaleCredit(status({ open: '4500.00' }), 'WEEKLY', m('500.00'))).toEqual({ usesOverride: false });
    expect(code(() => assertSaleCredit(status({ open: '4500.00' }), 'WEEKLY', m('2000.00')))).toBe('CREDIT_LIMIT_EXCEEDED');
  });

  it('ADR-0047: what is paid with the sale counts — 4,500 owed and a 2,000 sale fit a 5,000 limit once 1,500 is paid', () => {
    expect(assertSaleCredit(status({ open: '4500.00' }), 'WEEKLY', m('2000.00'), { paidNow: m('1500.00') })).toEqual({ usesOverride: false });
    expect(code(() => assertSaleCredit(status({ open: '4500.00' }), 'WEEKLY', m('2000.00'), { paidNow: m('1499.99') }))).toBe('CREDIT_LIMIT_EXCEEDED');
  });

  it('ADR-0047: bill to bill takes a new bill only once the last one is cleared — part-paid is not cleared', () => {
    expect(assertSaleCredit(status({ mode: 'BILL_TO_BILL' }), 'BILL_TO_BILL', m('500.00'))).toEqual({ usesOverride: false });
    const refused = (() => { try { assertSaleCredit(status({ mode: 'BILL_TO_BILL', open: '0.01' }), 'BILL_TO_BILL', m('500.00')); return null; } catch (e) { return e as DomainError; } })();
    expect(refused).toMatchObject({ code: 'CREDIT_BLOCKED', details: { reasons: [{ code: 'UNPAID_BILL', amount: '0.01' }] } });
    // CRD-006: a manager's same-day override still releases it for one sale.
    expect(assertSaleCredit(status({ mode: 'BILL_TO_BILL', open: '100.00', override: true }), 'BILL_TO_BILL', m('500.00'))).toEqual({ usesOverride: true });
  });

  it('ADR-0047: the limit binds bill to bill too — a limit of 0 means paying in full', () => {
    const none = status({ mode: 'BILL_TO_BILL', limit: '0.00' });
    expect(code(() => assertSaleCredit(none, 'BILL_TO_BILL', m('2000.00')))).toBe('CREDIT_LIMIT_EXCEEDED');
    expect(code(() => assertSaleCredit(none, 'BILL_TO_BILL', m('2000.00'), { paidNow: m('1999.99') }))).toBe('CREDIT_LIMIT_EXCEEDED');
    expect(assertSaleCredit(none, 'BILL_TO_BILL', m('2000.00'), { paidNow: m('2000.00') })).toEqual({ usesOverride: false });
  });

  it('ADR-0047, ADR-0038: an order on its way is a bill of its own — the next waits, but it never blocks itself', () => {
    const waiting = status({ mode: 'BILL_TO_BILL', committed: '300.00' });
    const refused = (() => { try { assertSaleCredit(waiting, 'BILL_TO_BILL', m('50.00')); return null; } catch (e) { return e as DomainError; } })();
    expect(refused).toMatchObject({ code: 'CREDIT_BLOCKED', details: { reasons: [{ code: 'DISPATCH_PENDING', amount: '300.00' }] } });
    // Confirming that same order: nothing else is on its way.
    expect(assertSaleCredit(waiting, 'BILL_TO_BILL', m('300.00'), { committed: m('0.00') })).toEqual({ usesOverride: false });
    // A cycle store may have orders on their way; they only count against its limit.
    expect(assertSaleCredit(status({ committed: '300.00' }), 'WEEKLY', m('4700.00'))).toEqual({ usesOverride: false });
    expect(code(() => assertSaleCredit(status({ committed: '300.00' }), 'WEEKLY', m('4700.01')))).toBe('CREDIT_LIMIT_EXCEEDED');
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

describe('open sales (ADR-0052)', () => {
  it('SAL-015, SAL-016: switched on and within the limit, an open sale goes through; otherwise it says why it waits', () => {
    const on = { switchedOn: true, limit: m('500.00') };
    expect(openSaleGrounds(m('500.00'), on)).toEqual([]); // the limit itself is within it
    expect(openSaleGrounds(m('500.01'), on)).toEqual(['ABOVE_LIMIT']);
    expect(openSaleGrounds(m('10.00'), { ...on, switchedOn: false })).toEqual(['SWITCHED_OFF']);
    expect(openSaleGrounds(m('900.00'), { switchedOn: false, limit: m('500.00') })).toEqual(['SWITCHED_OFF', 'ABOVE_LIMIT']);
    expect(openSaleGrounds(m('0.01'), { switchedOn: true, limit: m('0.00') })).toEqual(['ABOVE_LIMIT']); // a limit of 0: every one waits
  });

  it('SAL-013: paid in full means the exact total', () => {
    expect(code(() => assertPaidInFull(m('180.00'), m('180.00')))).toBe('NO_ERROR');
    expect(code(() => assertPaidInFull(m('180.00'), m('180.0')))).toBe('NO_ERROR');
    for (const paid of [null, m('179.99'), m('180.01'), m('0.00')]) expect(code(() => assertPaidInFull(m('180.00'), paid))).toBe('OPEN_SALE_PAID_IN_FULL');
  });
});
