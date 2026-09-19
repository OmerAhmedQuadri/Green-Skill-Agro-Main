import type { DomainError } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { mailer } from '../../test/mailer';
import { aPhoto } from '../../test/media';
import { aSellingSeller } from '../../test/sales';
import { deliverPendingEmails, listMyNotifications } from '../notifications';
import { getDb } from '../runtime';
import { recordSale } from '../sales';
import { setCeiling, updateSettings } from '../system';
import { cashInHand, checkCeilings, decideSettlement, getSettlement, listFlags, listSellerCash, listSettlements, sellerExposure, submitSettlement } from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async (now?: Date) => ctxFor(await anAccount('ADMIN'), now ? { now } : {});
const hours = (n: number) => new Date(Date.now() + n * 3_600_000);
const year = new Date().toISOString().slice(0, 4);
const ledgerOf = (sellerId: string) => ownerQuery<{ entry_type: string; amount: string }>(
  'select entry_type, amount from cash_ledger_entries where seller_id = $1 order by amount', [sellerId]);

/** A seller holding cash: two bags sold to a bill-to-bill store, paid in cash. */
async function aSellerWithCash(packs = 2) {
  const ctx = await admin();
  const setup = await aSellingSeller(ctx, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
  await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs }], payment: { method: 'CASH' } });
  return { ...setup, admin: ctx };
}

const aDeposit = async (ctx: Parameters<typeof submitSettlement>[0], amount: string) =>
  submitSettlement(ctx, { route: 'BANK_DEPOSIT', amount, depositedOn: '2026-09-20', photoId: await aPhoto(ctx, 'DEPOSIT_SLIP') });

describe('settling cash (workflow M, CSH-002..006)', () => {
  it('CSH-002, CSH-005: a declared deposit posts nothing — the cash is still the seller\'s', async () => {
    const { seller } = await aSellerWithCash();
    const settlement = await aDeposit(seller.ctx, '180.00');
    expect(settlement).toMatchObject({
      number: `ST-${year}-000001`, status: 'SUBMITTED', route: 'BANK_DEPOSIT', declaredAmount: '180.00',
      depositedOn: '2026-09-20', approvedAmount: null, receivedBy: null,
    });
    expect(await cashInHand(getDb(), seller.account.id)).toBe('180.00');
    expect(await ledgerOf(seller.account.id)).toEqual([{ entry_type: 'COLLECTION', amount: '180.00' }]);
  });

  it('CSH-005: a seller cannot declare more cash than the ledger says they hold', async () => {
    const { seller } = await aSellerWithCash();
    expect(await code(aDeposit(seller.ctx, '180.01'))).toBe('SETTLEMENT_ABOVE_CASH_IN_HAND');
    expect(await code(aDeposit(seller.ctx, '0.00'))).toBe('INVALID_MONEY');
  });

  it('CSH-003: a handover names the manager who took the cash, and tells them', async () => {
    const { seller, admin: ctx } = await aSellerWithCash();
    expect(await code(submitSettlement(seller.ctx, { route: 'MANAGER_HANDOVER', amount: '90.00', photoId: await aPhoto(seller.ctx, 'DEPOSIT_SLIP') })))
      .toBe('RECEIVER_REQUIRED');
    const handover = await submitSettlement(seller.ctx, {
      route: 'MANAGER_HANDOVER', amount: '90.00', receivedById: ctx.user.id, photoId: await aPhoto(seller.ctx, 'DEPOSIT_SLIP'),
    });
    expect(handover).toMatchObject({ route: 'MANAGER_HANDOVER', receivedBy: { id: ctx.user.id }, depositedOn: null });
    expect((await listMyNotifications(ctx, {})).items.map((n) => n.kind)).toContain('SETTLEMENT_SUBMITTED');
  });

  it('CSH-004, CSH-005: approval is what moves the money, and never by the seller themselves', async () => {
    const { seller, admin: ctx } = await aSellerWithCash();
    const settlement = await aDeposit(seller.ctx, '180.00');
    expect(await code(decideSettlement(seller.ctx, settlement.id, { version: settlement.version, approve: true }))).toBe('FORBIDDEN');
    const approved = await decideSettlement(ctx, settlement.id, { version: settlement.version, approve: true });
    expect(approved).toMatchObject({ status: 'APPROVED', approvedAmount: '180.00', decidedBy: { id: ctx.user.id }, shortfall: null, discrepancy: null });
    expect(await cashInHand(getDb(), seller.account.id)).toBe('0.00');
    expect(await ledgerOf(seller.account.id)).toEqual([
      { entry_type: 'SETTLEMENT_APPROVED', amount: '-180.00' }, { entry_type: 'COLLECTION', amount: '180.00' },
    ]);
    expect(await code(decideSettlement(ctx, settlement.id, { version: approved.version, approve: false, comment: 'again' }))).toBe('ALREADY_DECIDED');
  });

  it('CSH-003, CSH-004: a handover is approved by the manager it was handed to', async () => {
    const { seller, admin: ctx } = await aSellerWithCash();
    const other = await admin();
    const handover = await submitSettlement(seller.ctx, {
      route: 'MANAGER_HANDOVER', amount: '90.00', receivedById: ctx.user.id, photoId: await aPhoto(seller.ctx, 'DEPOSIT_SLIP'),
    });
    expect(await code(decideSettlement(other, handover.id, { version: handover.version, approve: true }))).toBe('FORBIDDEN');
    expect(await decideSettlement(ctx, handover.id, { version: handover.version, approve: true })).toMatchObject({ status: 'APPROVED' });
  });

  it('CSH-006: approved for less — the difference is kept, and the rest stays in the seller\'s hands', async () => {
    const { seller, admin: ctx } = await aSellerWithCash();
    const settlement = await aDeposit(seller.ctx, '180.00');
    expect(await code(decideSettlement(ctx, settlement.id, { version: settlement.version, approve: true, amount: '150.00' }))).toBe('REASON_REQUIRED');
    const approved = await decideSettlement(ctx, settlement.id, { version: settlement.version, approve: true, amount: '150.00', comment: 'Counted 150' });
    expect(approved).toMatchObject({ declaredAmount: '180.00', approvedAmount: '150.00', shortfall: '30.00', discrepancy: null, decisionComment: 'Counted 150' });
    expect(await cashInHand(getDb(), seller.account.id)).toBe('30.00');
  });

  it('CSH-006: approved for more than the ledger knew about — a discrepancy, not a negative balance', async () => {
    const { seller, admin: ctx } = await aSellerWithCash();
    const settlement = await aDeposit(seller.ctx, '180.00');
    const approved = await decideSettlement(ctx, settlement.id, { version: settlement.version, approve: true, amount: '200.00', comment: 'Counted 200' });
    expect(approved).toMatchObject({ approvedAmount: '200.00', shortfall: null, discrepancy: '20.00' });
    expect(await cashInHand(getDb(), seller.account.id)).toBe('0.00');
    expect(await ledgerOf(seller.account.id)).toEqual([
      { entry_type: 'SETTLEMENT_APPROVED', amount: '-200.00' }, { entry_type: 'DISCREPANCY', amount: '20.00' }, { entry_type: 'COLLECTION', amount: '180.00' },
    ]);
  });

  it('CSH-005: a rejection needs a comment and moves nothing; the seller submits again', async () => {
    const { seller, admin: ctx } = await aSellerWithCash();
    const settlement = await aDeposit(seller.ctx, '180.00');
    expect(await code(decideSettlement(ctx, settlement.id, { version: settlement.version, approve: false }))).toBe('REASON_REQUIRED');
    const rejected = await decideSettlement(ctx, settlement.id, { version: settlement.version, approve: false, comment: 'No slip attached' });
    expect(rejected).toMatchObject({ status: 'REJECTED', approvedAmount: null });
    expect(await cashInHand(getDb(), seller.account.id)).toBe('180.00');
    expect((await listMyNotifications(seller.ctx, {})).items.map((n) => n.kind)).toContain('SETTLEMENT_REJECTED');
    expect((await aDeposit(seller.ctx, '180.00')).status).toBe('SUBMITTED');
  });

  it('SECURITY §3: a seller sees only their own settlements; managers see them all', async () => {
    const { seller, admin: ctx } = await aSellerWithCash();
    const settlement = await aDeposit(seller.ctx, '90.00');
    const other = await aSellerWithCash();
    expect((await listSettlements(other.seller.ctx, {})).items).toEqual([]);
    expect(await code(getSettlement(other.seller.ctx, settlement.id))).toBe('NOT_FOUND');
    expect((await listSettlements(ctx, {})).items.map((s) => s.id)).toContain(settlement.id);
  });
});

describe('ceilings (LIM-002..005, CSH-007, OQ-021)', () => {
  it('OQ-021: the stock on a seller\'s vehicle is valued at the base price list', async () => {
    const { seller } = await aSellerWithCash(2);
    const [exposure] = await sellerExposure(getDb(), [seller.account.id]);
    expect(exposure).toMatchObject({ cashInHand: '180.00', stockValue: '720.00' }); // 8 bags left at 90.00
  });

  it('LIM-002, LIM-004: over the ceiling raises a dashboard flag and warns the seller in the app and by email', async () => {
    const { seller, admin: ctx } = await aSellerWithCash();
    await setCeiling(ctx, { kind: 'CASH_IN_HAND', sellerId: null, amount: '100.00' });
    expect(await checkCeilings(ctx)).toMatchObject({ raised: 1, reminded: 0, cleared: 0 });
    expect(await listFlags(ctx)).toMatchObject([{ kind: 'CASH_IN_HAND', seller: { id: seller.account.id }, amount: '180.00', ceiling: '100.00', remindersSent: 0 }]);
    expect((await listMyNotifications(seller.ctx, {})).items.map((n) => n.kind)).toContain('CEILING_BREACHED');
    await deliverPendingEmails(mailer, new Date());
    expect(mailer.sent.at(-1)?.subject).toBe('You are over your limit');
    // LIM-005: a warning only — the seller keeps selling.
    expect(await checkCeilings(ctx)).toMatchObject({ raised: 0, reminded: 0 });
  });

  it('LIM-003, OQ-021: the warning repeats on its interval, and managers hear from the second reminder', async () => {
    const { seller, admin: ctx } = await aSellerWithCash();
    await setCeiling(ctx, { kind: 'CASH_IN_HAND', sellerId: null, amount: '100.00' });
    await updateSettings(ctx, [{ key: 'ceilings.reminder_interval_hours', value: 6 }]);
    await checkCeilings(await admin());
    // `ctx` holds cash.view_cash_in_hand and is not the one running the sweep, so it hears when managers are told.
    expect(await checkCeilings(await admin(hours(7)))).toMatchObject({ reminded: 1 });
    expect((await listMyNotifications(ctx, {})).items.map((n) => n.kind)).not.toContain('CEILING_BREACHED');
    expect(await checkCeilings(await admin(hours(14)))).toMatchObject({ reminded: 1 });
    expect((await listMyNotifications(ctx, {})).items.map((n) => n.kind)).toContain('CEILING_BREACHED');
    expect((await listFlags(ctx))[0]).toMatchObject({ remindersSent: 2 });
    expect((await listSellerCash(ctx)).find((s) => s.sellerId === seller.account.id)).toMatchObject({ over: ['CASH_IN_HAND'] });
  });

  it('CSH-007: settling back under the ceiling clears the flag', async () => {
    const { seller, admin: ctx } = await aSellerWithCash();
    await setCeiling(ctx, { kind: 'CASH_IN_HAND', sellerId: null, amount: '100.00' });
    await checkCeilings(ctx);
    expect(await listFlags(ctx)).toHaveLength(1);
    const settlement = await aDeposit(seller.ctx, '150.00');
    await decideSettlement(ctx, settlement.id, { version: settlement.version, approve: true });
    expect(await listFlags(ctx)).toEqual([]);
  });

  it('OQ-005: a seller\'s own ceiling overrides the global one', async () => {
    const { seller, admin: ctx } = await aSellerWithCash();
    await setCeiling(ctx, { kind: 'CASH_IN_HAND', sellerId: null, amount: '100.00' });
    await setCeiling(ctx, { kind: 'CASH_IN_HAND', sellerId: seller.account.id, amount: '500.00' });
    expect(await checkCeilings(ctx)).toMatchObject({ raised: 0 });
    expect(await listFlags(ctx)).toEqual([]);
  });
});
