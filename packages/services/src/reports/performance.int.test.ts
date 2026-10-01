import { businessDate, businessMonth, type DomainError } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { anAccount, ctxFor } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { aSellingSeller } from '../../test/sales';
import { decideSettlement, submitSettlement } from '../cash';
import { recordSale } from '../sales';
import { myStanding } from '../targets';
import { myPerformance } from './performance';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async () => ctxFor(await anAccount('ADMIN'));

/** The month before `month`, on the business calendar. */
const monthBefore = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/**
 * A seller's month: two cash sales and one by bank transfer, at 90.00 a bag,
 * then the first cash handed over and approved and the second still waiting.
 */
async function aSellersMonth() {
  const ctx = await admin();
  const setup = await aSellingSeller(ctx, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
  const sell = (packs: number, payment: { method: 'CASH' } | { method: 'BANK_TRANSFER'; reference: string }) =>
    recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs }], payment });
  await sell(3, { method: 'CASH' });                              // 270.00 cash
  await sell(1, { method: 'BANK_TRANSFER', reference: 'TRX-1' }); //  90.00 bank
  await sell(1, { method: 'CASH' });                              //  90.00 cash
  const today = businessDate(new Date());
  const first = await submitSettlement(setup.seller.ctx, {
    route: 'BANK_DEPOSIT', amount: '270.00', depositedOn: today, photoId: await aPhoto(setup.seller.ctx, 'DEPOSIT_SLIP'),
  });
  await decideSettlement(ctx, first.id, { version: first.version, approve: true });
  await submitSettlement(setup.seller.ctx, {
    route: 'BANK_DEPOSIT', amount: '90.00', depositedOn: today, photoId: await aPhoto(setup.seller.ctx, 'DEPOSIT_SLIP'),
  });
  return setup;
}

describe("a seller's own performance (RPT-010, RPT-008)", () => {
  it('RPT-010: sales, collections, cash and commission for the month, in one place', async () => {
    const setup = await aSellersMonth();
    const mine = await myPerformance(setup.seller.ctx);
    expect(mine.month).toBe(businessMonth(new Date()));
    expect(mine.sales).toMatchObject({ sold: '450.00', sales: 3, returned: '0.00', net: '450.00' });
    // RPT-008: by method — the bank transfer is a collection, but never cash in hand.
    expect(mine.collected).toEqual({ cash: '360.00', bank: '90.00', total: '450.00', payments: 3 });
    expect(mine.handedOver).toBe('270.00');
    // 360 collected in cash, 270 approved out; the 90 awaiting moves nothing until it is decided.
    // ADR-0046: the 90 by bank transfer earns nothing until someone confirms it arrived.
    expect(mine.now).toEqual({ cashInHand: '90.00', awaitingApproval: '90.00', transfersAwaiting: '90.00' });
  });

  it('COM-001: the commission is the Targets screen\'s own figure, so the two cannot disagree', async () => {
    const setup = await aSellersMonth();
    const mine = await myPerformance(setup.seller.ctx);
    const standing = await myStanding(setup.seller.ctx);
    expect(mine.commission).toEqual({ base: standing.base, rate: standing.rate, commission: standing.commission, final: standing.final });
  });

  it('RPT-010: an earlier month shows that month, and "right now" stays right now', async () => {
    const setup = await aSellersMonth();
    const before = await myPerformance(setup.seller.ctx, { month: monthBefore(businessMonth(new Date())) });
    expect(before.sales).toMatchObject({ sold: '0.00', sales: 0 });
    expect(before.collected.total).toBe('0.00');
    expect(before.handedOver).toBe('0.00');
    expect(before.now).toEqual({ cashInHand: '90.00', awaitingApproval: '90.00', transfersAwaiting: '90.00' });
  });

  it('CSH-006: handed over counts what the manager approved, not what was declared', async () => {
    const ctx = await admin();
    const setup = await aSellingSeller(ctx, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 3 }], payment: { method: 'CASH' } });
    const declared = await submitSettlement(setup.seller.ctx, {
      route: 'BANK_DEPOSIT', amount: '270.00', depositedOn: businessDate(new Date()), photoId: await aPhoto(setup.seller.ctx, 'DEPOSIT_SLIP'),
    });
    await decideSettlement(ctx, declared.id, { version: declared.version, approve: true, amount: '250.00', comment: 'Counted less than declared' });
    expect((await myPerformance(setup.seller.ctx)).handedOver).toBe('250.00');
  });

  it('RPT-010: the seller\'s own — nobody else has one, and a month must be a month', async () => {
    const setup = await aSellersMonth();
    expect(await code(myPerformance(await admin()))).toBe('FORBIDDEN');
    expect(await code(myPerformance(await ctxFor(await anAccount('MANAGER'))))).toBe('FORBIDDEN');
    expect(await code(myPerformance(setup.seller.ctx, { month: '2026-13' }))).toBe('INVALID_DATE');
  });
});
