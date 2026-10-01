import { businessDayStart, businessMonth, type DomainError } from '@gsa/core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { aSellingSeller } from '../../test/sales';
import { listMyNotifications } from '../notifications';
import { myPerformance } from '../reports';
import { getDb } from '../runtime';
import { recordSale } from '../sales';
import { updateSettings } from '../system';
import { confirmedTransfersFor, myStanding } from '../targets';
import { adjustBalance, decideTransfer, getCreditStatus, listAwaitingTransfers, listStoreLedger, recordPayment } from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const pgCode = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: { message?: string; cause?: { code?: string } }) => e.cause?.code ?? e.message ?? 'UNKNOWN');
const admin = async (now?: Date) => ctxFor(await anAccount('ADMIN'), now ? { now } : {});
const period = businessMonth(new Date());
const HOUR = 3_600_000;
/** Midday on the 15th of the Riyadh month `n` after this one, so this one has frozen. */
const monthsOn = (n: number) => {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return new Date(businessDayStart(new Date(Date.UTC(y, m - 1 + n, 15)).toISOString().slice(0, 10)).getTime() + 12 * HOUR);
};
const notificationsOf = async (ctx: Awaited<ReturnType<typeof admin>>) => (await listMyNotifications(ctx, { limit: 50 })).items;

/** A bill-to-bill store paying for one bag (90.00) by bank transfer, as the seller records it. */
async function aTransferredSale() {
  const approver = await admin();
  const setup = await aSellingSeller(approver, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
  const sale = await recordSale(setup.seller.ctx, {
    storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 1 }], payment: { method: 'BANK_TRANSFER', reference: 'TRX-4471' },
  });
  if (!sale.payment) throw new Error('the sale was not paid');
  return { ...setup, approver, sale, transfer: sale.payment };
}

describe("a store's bank transfer, confirmed before it counts (ADR-0046)", () => {
  it('ADR-0046: a recorded transfer waits for an approver, who is told about it', async () => {
    const { approver, seller, store, transfer } = await aTransferredSale();
    const awaiting = await listAwaitingTransfers(approver, { limit: 100 });
    expect(awaiting.items.find((t) => t.id === transfer.id)).toMatchObject({
      number: transfer.number, amount: '90.00', reference: 'TRX-4471', store: { id: store.id }, seller: { id: seller.account.id }, decidable: true,
    });
    expect(awaiting.total).toBeGreaterThanOrEqual(1);
    expect((await notificationsOf(approver)).find((n) => n.params.number === transfer.number))
      .toMatchObject({ kind: 'TRANSFER_RECORDED', params: { amount: '90.00' }, link: '/console/cash' });
    // The list is the approvers': a seller has no view of anybody's transfers.
    expect(await code(listAwaitingTransfers(seller.ctx))).toBe('FORBIDDEN');
  });

  it('ADR-0046, COM-001: confirmed, it counts towards collections and commission, in the month it was received', async () => {
    const { approver, seller, transfer } = await aTransferredSale();
    // Not yet: the money has not been seen to arrive.
    expect((await myStanding(seller.ctx)).base).toBe('0.00');
    expect((await myPerformance(seller.ctx)).now.transfersAwaiting).toBe('90.00');

    expect(await decideTransfer(approver, transfer.id, { outcome: 'CONFIRMED' })).toMatchObject({ paymentId: transfer.id, outcome: 'CONFIRMED' });
    expect((await myStanding(seller.ctx)).base).toBe('90.00');
    const mine = await myPerformance(seller.ctx);
    expect(mine.now.transfersAwaiting).toBe('0.00');
    expect(mine.commission.base).toBe('90.00');
    expect((await listAwaitingTransfers(approver, { limit: 100 })).items.map((t) => t.id)).not.toContain(transfer.id);
  });

  it("ADR-0046, CRD-005: not received, the store owes it again by the sale's own date, and the seller is told", async () => {
    const { approver, seller, store, sale, transfer } = await aTransferredSale();
    expect((await getCreditStatus(approver, store.id)).outstanding).toBe('0.00');

    await decideTransfer(approver, transfer.id, { outcome: 'NOT_RECEIVED', reason: 'Not on the statement' });
    const credit = await getCreditStatus(approver, store.id);
    expect(credit.outstanding).toBe('90.00');
    // Bill to bill with no credit: the unpaid sale stops the next one until it is paid.
    expect(credit.blocked).toBe(true);

    const ledger = await listStoreLedger(approver, store.id);
    const debit = ledger.find((e) => e.entryType === 'SALE' && e.reference.id === sale.id);
    const reinstated = ledger.find((e) => e.reference.type === 'TRANSFER_NOT_RECEIVED');
    expect(reinstated).toMatchObject({
      entryType: 'ADJUSTMENT', amount: '90.00', note: 'Not on the statement', paymentNumber: transfer.number, dueOn: debit?.dueOn,
      reference: { type: 'TRANSFER_NOT_RECEIVED', id: transfer.id },
    });
    expect((await notificationsOf(seller.ctx)).find((n) => n.kind === 'TRANSFER_NOT_RECEIVED')).toMatchObject({
      params: { number: transfer.number, amount: '90.00', reason: 'Not on the statement' }, link: `/field/stores/${store.id}`,
    });
    // It never reached the business, so it never earns anything, and nothing is left awaiting.
    expect((await myStanding(seller.ctx)).base).toBe('0.00');
    expect((await myPerformance(seller.ctx)).now.transfersAwaiting).toBe('0.00');
  });

  it('ADR-0046: a transfer that settled debts due on two dates puts each back on its own date', async () => {
    const recorder = await admin();
    const { store } = await aSellingSeller(recorder, { creditMode: 'WEEKLY', creditLimit: '1000.00' });
    await adjustBalance(recorder, store.id, { amount: '50.00', reason: 'Opening balance', dueOn: '2026-09-01' });
    await adjustBalance(recorder, store.id, { amount: '40.00', reason: 'Opening balance', dueOn: '2026-09-15' });
    const paid = await recordPayment(recorder, { storeId: store.id, amount: '90.00', method: 'BANK_TRANSFER', reference: 'TRX-2' });

    // Four eyes: whoever recorded it does not decide it.
    expect(await code(decideTransfer(recorder, paid.id, { outcome: 'CONFIRMED' }))).toBe('FOUR_EYES');
    const other = await admin();
    expect(await code(decideTransfer(other, paid.id, { outcome: 'NOT_RECEIVED', reason: '  ' }))).toBe('REASON_REQUIRED');
    await decideTransfer(other, paid.id, { outcome: 'NOT_RECEIVED', reason: 'Bounced' });
    expect(await code(decideTransfer(other, paid.id, { outcome: 'CONFIRMED' }))).toBe('ALREADY_DECIDED');

    const back = (await listStoreLedger(recorder, store.id)).filter((e) => e.reference.type === 'TRANSFER_NOT_RECEIVED');
    expect(back).toHaveLength(2);
    expect(Object.fromEntries(back.map((e) => [e.dueOn, e.amount]))).toEqual({ '2026-09-01': '50.00', '2026-09-15': '40.00' });
    expect((await getCreditStatus(recorder, store.id)).outstanding).toBe('90.00');
    // Recorded in the console, so the word points there.
    expect((await notificationsOf(recorder)).find((n) => n.kind === 'TRANSFER_NOT_RECEIVED')?.link).toBe(`/console/stores/${store.id}`);
  });

  it('ADR-0046: only a bank transfer is decided, and only by an approver', async () => {
    const approver = await admin();
    const setup = await aSellingSeller(approver, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    const cash = await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 1 }], payment: { method: 'CASH' } });
    if (!cash.payment) throw new Error('the sale was not paid');
    // Cash is decided at its settlement, not here.
    expect(await code(decideTransfer(approver, cash.payment.id, { outcome: 'CONFIRMED' }))).toBe('NOT_FOUND');
    const { transfer, seller } = await aTransferredSale();
    expect(await code(decideTransfer(seller.ctx, transfer.id, { outcome: 'CONFIRMED' }))).toBe('FORBIDDEN');
    expect(await code(decideTransfer(await ctxFor(await anAccount('MANAGER')), transfer.id, { outcome: 'CONFIRMED' }))).toBe('FORBIDDEN');
  });

  it('ADR-0046, COM-008: confirmed after its month froze, it counts in the month it was confirmed', async () => {
    const { approver, seller, transfer } = await aTransferredSale();
    await updateSettings(approver, [{ key: 'period.close_after_days', value: 3 }]);
    const later = await admin(monthsOn(1));
    await decideTransfer(later, transfer.id, { outcome: 'CONFIRMED' });
    const byMonth = (await confirmedTransfersFor(getDb(), [seller.account.id], 3)).get(seller.account.id);
    expect(Object.fromEntries(byMonth ?? [])).toEqual({ [businessMonth(monthsOn(1))]: '90.00' });
  });

  it('ADR-0046: the database holds the rules too — only a bank transfer, and never not received without a reason', async () => {
    const approver = await admin();
    const setup = await aSellingSeller(approver, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    const cash = await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 1 }], payment: { method: 'CASH' } });
    const { transfer } = await aTransferredSale();
    const insert = (paymentId: string, outcome: string, reason: string | null) => ownerQuery(
      `insert into transfer_decisions (id, payment_id, outcome, reason, decided_at, decided_by, branch_id)
       select gen_random_uuid(), $1, $2::transfer_outcome, $3, now(), $4, branch_id from payments where id = $1`,
      [paymentId, outcome, reason, approver.user.id],
    );
    await expect(insert(cash.payment?.id ?? '', 'CONFIRMED', null)).rejects.toMatchObject({ constraint: 'transfer_decisions_bank_transfer' });
    await expect(insert(transfer.id, 'NOT_RECEIVED', ' ')).rejects.toMatchObject({ constraint: 'transfer_decisions_reason' });
    // And one decision per transfer.
    await decideTransfer(approver, transfer.id, { outcome: 'CONFIRMED' });
    await expect(insert(transfer.id, 'CONFIRMED', null)).rejects.toMatchObject({ constraint: 'transfer_decisions_payment_id_unique' });
    // Final: the application's own role cannot change or remove a decision.
    expect(await pgCode(getDb().execute(sql`update transfer_decisions set outcome = 'NOT_RECEIVED' where payment_id = ${transfer.id}`))).toBe('42501');
    expect(await pgCode(getDb().execute(sql`delete from transfer_decisions where payment_id = ${transfer.id}`))).toBe('42501');
  });
});
