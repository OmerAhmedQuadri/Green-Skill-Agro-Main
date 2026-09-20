import { businessMonth, type DomainError } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { anAccount, ctxFor } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { aSellingSeller } from '../../test/sales';
import { decideSettlement, submitSettlement } from '../cash';
import { listMyNotifications } from '../notifications';
import { recordReturn } from '../returns';
import { recordPayment } from '../stores';
import { getDb } from '../runtime';
import { recordSale } from '../sales';
import { setCommissionRate, updateSettings } from '../system';
import { checkPace, closePeriods, listStandings, listTargets, myStanding, setTarget, settledCashByPeriod } from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async (now?: Date) => ctxFor(await anAccount('ADMIN'), now ? { now } : {});
const period = businessMonth(new Date());
/** An instant in a later month, so the period under test has frozen. */
const monthsOn = (n: number) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + n, 15);
  return d;
};

/**
 * A seller who sold three bags at 90.00 for cash, declared the 270.00 and had a
 * manager approve it — so the money reached the business (COM-001).
 */
async function aSellerWhoSettled(ctx: Awaited<ReturnType<typeof admin>>, approved?: string) {
  const setup = await aSellingSeller(ctx, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
  await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 3 }], payment: { method: 'CASH' } });
  const declared = await submitSettlement(setup.seller.ctx, {
    route: 'BANK_DEPOSIT', amount: '270.00', depositedOn: '2026-09-20', photoId: await aPhoto(setup.seller.ctx, 'DEPOSIT_SLIP'),
  });
  // CSH-006: approving less than was declared needs a comment, so a shortfall always carries a reason.
  await decideSettlement(ctx, declared.id, {
    version: declared.version, approve: true,
    ...(approved ? { amount: approved, comment: 'Counted less than declared' } : {}),
  });
  return setup;
}

describe('monthly targets and commission (workflow O, TGT-001..006, COM-001..009)', () => {
  it('TGT-001, TGT-002, TGT-003: a target is one seller, one calendar month, and any combination of the four figures', async () => {
    const ctx = await admin();
    const { seller } = await aSellingSeller(ctx);
    const set = await setTarget(ctx, { sellerId: seller.account.id, period, goals: { REVENUE: '50000.00', NEW_STORES: '4' } });
    expect(set).toMatchObject({ period, goals: { REVENUE: '50000.00', NEW_STORES: '4' }, seller: { id: seller.account.id } });
    expect(set.goals).not.toHaveProperty('PACKS_SOLD');
    // Setting it again replaces the figures rather than adding a second target for the month.
    const again = await setTarget(ctx, { sellerId: seller.account.id, period, goals: { REVENUE: '60000.00' } });
    expect(again.id).toBe(set.id);
    expect(again.goals).toEqual({ REVENUE: '60000.00' });
    expect((await listTargets(ctx, period)).filter((t) => t.seller.id === seller.account.id)).toHaveLength(1);
  });

  it('TGT-003: a target with nothing set, or a figure of zero, is refused', async () => {
    const ctx = await admin();
    const { seller } = await aSellingSeller(ctx);
    expect(await code(setTarget(ctx, { sellerId: seller.account.id, period, goals: {} }))).toBe('TARGET_EMPTY');
    expect(await code(setTarget(ctx, { sellerId: seller.account.id, period, goals: { REVENUE: '0' } }))).toBe('TARGET_NOT_POSITIVE');
  });

  it('TGT-004, COM-001: the seller sees their own progress and commission on cash that reached the business', async () => {
    const ctx = await admin();
    const setup = await aSellerWhoSettled(ctx);
    await setTarget(ctx, { sellerId: setup.seller.account.id, period, goals: { REVENUE: '200.00', COLLECTED: '200.00' } });
    const standing = await myStanding(setup.seller.ctx);
    expect(standing.progress.metrics.map((m) => [m.metric, m.actual, m.met]))
      .toEqual([['REVENUE', '270.00', true], ['COLLECTED', '270.00', true]]);
    expect(standing).toMatchObject({ base: '270.00', final: false });
    expect(standing.progress.met).toBe(true);
  });

  it('COM-001: cash the seller is still holding earns nothing — only what a manager approved', async () => {
    const ctx = await admin();
    const setup = await aSellingSeller(ctx, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 3 }], payment: { method: 'CASH' } });
    // Collected, never settled: the sale counts towards revenue, the cash counts towards nothing.
    const standing = await myStanding(setup.seller.ctx);
    expect(standing.base).toBe('0.00');
  });

  it('CSH-006, COM-001: a settlement approved short puts only the approved amount in the base', async () => {
    const ctx = await admin();
    const setup = await aSellerWhoSettled(ctx, '200.00');
    expect((await myStanding(setup.seller.ctx)).base).toBe('200.00');
  });

  it('COM-002, COM-003: the rate follows whether the month was met, and no rate is not a commission of zero', async () => {
    const ctx = await admin();
    const setup = await aSellerWhoSettled(ctx);
    await setTarget(ctx, { sellerId: setup.seller.account.id, period, goals: { REVENUE: '100.00' } });
    expect(await myStanding(setup.seller.ctx)).toMatchObject({ rate: null, commission: null });
    await setCommissionRate(ctx, setup.seller.account.id, { onTarget: '5', belowTarget: '2' });
    expect(await myStanding(setup.seller.ctx)).toMatchObject({ commission: '13.50' }); // 270 met, at 5%
    await setTarget(ctx, { sellerId: setup.seller.account.id, period, goals: { REVENUE: '5000.00' } });
    expect(await myStanding(setup.seller.ctx)).toMatchObject({ commission: '5.40' }); // missed, at 2%
  });

  it('COM-007: a seller sees only their own figures, and cannot set anybody\'s target', async () => {
    const ctx = await admin();
    const setup = await aSellerWhoSettled(ctx);
    expect((await listStandings(setup.seller.ctx)).map((s) => s.seller.id)).toEqual([setup.seller.account.id]);
    expect((await listStandings(ctx)).map((s) => s.seller.id)).toContain(setup.seller.account.id);
    expect(await code(setTarget(setup.seller.ctx, { sellerId: setup.seller.account.id, period, goals: { REVENUE: '1.00' } }))).toBe('FORBIDDEN');
  });

  it('TGT-005, COM-008: the month freezes into a snapshot, written once, and cannot then be retargeted', async () => {
    const ctx = await admin();
    const setup = await aSellerWhoSettled(ctx);
    await setTarget(ctx, { sellerId: setup.seller.account.id, period, goals: { REVENUE: '5000.00' } });
    await updateSettings(ctx, [{ key: 'period.close_after_days', value: 3 }]);
    const later = await admin(monthsOn(1));
    expect((await closePeriods(later)).frozen).toBeGreaterThan(0);
    const standing = await myStanding({ ...setup.seller.ctx, now: later.now }, period);
    expect(standing).toMatchObject({ final: true, base: '270.00' });
    expect(standing.progress.met).toBe(false);
    // Written once: a second run adds nothing, and the frozen month cannot be retargeted.
    expect((await closePeriods(await admin(monthsOn(1)))).frozen).toBe(0);
    expect(await code(setTarget(later, { sellerId: setup.seller.account.id, period, goals: { REVENUE: '100.00' } }))).toBe('PERIOD_CLOSED');
  });

  it('TGT-006: a seller far enough behind the pace their month needs is told, and so are their managers', async () => {
    const ctx = await admin();
    const setup = await aSellerWhoSettled(ctx);
    // A goal far beyond what they have sold, with the month well under way.
    await setTarget(ctx, { sellerId: setup.seller.account.id, period, goals: { REVENUE: '500000.00' } });
    await updateSettings(ctx, [{ key: 'targets.pace_threshold_percent', value: 80 }]);
    const midMonth = new Date();
    midMonth.setUTCDate(20);
    const later = await ctxFor(await anAccount('ADMIN'), { now: midMonth });

    const standing = await myStanding({ ...setup.seller.ctx, now: midMonth });
    expect(standing.behindPace).toBe(true);
    const warned = await checkPace(later);
    expect(warned.warned).toBeGreaterThan(0);
    const mine = await listMyNotifications(setup.seller.ctx, {});
    expect(mine.items.map((notification) => notification.kind)).toContain('TARGET_BEHIND_PACE');

    // A goal they have already passed is not behind anything.
    await setTarget(ctx, { sellerId: setup.seller.account.id, period, goals: { REVENUE: '1.00' } });
    expect((await myStanding({ ...setup.seller.ctx, now: midMonth })).behindPace).toBe(false);
  });

  it('COM-005: cash counts in the month it was received, once a manager approved it', async () => {
    const ctx = await admin();
    const setup = await aSellerWhoSettled(ctx);
    const settled = (await settledCashByPeriod(getDb(), [setup.seller.account.id], 3)).get(setup.seller.account.id);
    // Collected and approved today, so it belongs to this month and no other.
    expect(settled?.get(period)).toBe('270.00');
    expect([...(settled?.keys() ?? [])]).toEqual([period]);
  });

  it('COM-009: credit given against a store\'s other debts comes out of the base; credit against the sale itself does not', async () => {
    const ctx = await admin();
    const setup = await aSellingSeller(ctx, { packs: 12, creditMode: 'WEEKLY', creditLimit: '20000.00' });
    // One sale paid for, one left unpaid: the store owes for the second.
    const paid = await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 3 }] });
    await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 2 }] });
    await recordPayment(setup.seller.ctx, { storeId: setup.store.id, amount: paid.total, method: 'CASH' });
    const declared = await submitSettlement(setup.seller.ctx, {
      route: 'BANK_DEPOSIT', amount: paid.total, depositedOn: '2026-09-20', photoId: await aPhoto(setup.seller.ctx, 'DEPOSIT_SLIP'),
    });
    await decideSettlement(ctx, declared.id, { version: declared.version, approve: true });
    const before = await myStanding(setup.seller.ctx);
    expect(before.base).toBe('270.00');

    // Goods back from the sale that was paid for: the money stays with the
    // business, a receivable is cancelled instead, so the commission reverses.
    const line = paid.lines[0];
    if (!line) throw new Error('the sale has no lines');
    // RET-002: "uncleared payment" is for a sale still unpaid, so a sale that has
    // been paid for comes back as defective — the system refuses the other way round.
    await recordReturn(setup.seller.ctx, {
      saleId: paid.id, kind: 'CREDIT_NOTE', condition: 'DEFECTIVE',
      lines: [{ saleLineId: line.id, batchId: setup.bagBatch.batchId, packs: 1, saleable: false }],
    });
    const after = await myStanding(setup.seller.ctx);
    expect(Number(after.base)).toBeLessThan(Number(before.base));
  });
});
