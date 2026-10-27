import { businessDate, dec, money, type DomainError } from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { anAccount, ctxFor, PASSWORD } from '../../test/factories';
import { aSellingSeller, aVoucher, paid } from '../../test/sales';
import { aStore } from '../../test/stores';
import { cashInHand, postCashCorrection } from '../cash';
import type { Ctx } from '../context';
import { inTx } from '../platform';
import { collectedBySeller } from '../reports';
import { getDb } from '../runtime';
import { recordSale } from '../sales';
import {
  adjustBalance, decideStore, decideTransfer, getCreditStatus, listAwaitingTransfers, listStoreLedger, recordPayment, type LedgerEntry,
} from '../stores';
import { confirmedTransfersFor } from '../targets';
import { openCorrectionSession } from './sessions';
import { correctStoreEntry, listStoreCorrections, previewStoreCorrection } from './store-account';

const codeOf = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const pgCode = async (p: Promise<unknown>) =>
  p.then(() => 'NO_ERROR', (e: { message?: string; cause?: { code?: string } }) => e.cause?.code ?? e.message ?? 'UNKNOWN');
const REASON = 'Haneef\'s book says otherwise';
const today = businessDate(new Date());
const yesterday = businessDate(new Date(Date.now() - 86_400_000));

/** A Super Admin with a correction session open, and a seller at work with an approved weekly store. */
async function setup(opts: Parameters<typeof aSellingSeller>[1] = {}) {
  const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
  const selling = await aSellingSeller(owner, opts);
  await openCorrectionSession(owner, { password: PASSWORD, reason: 'Fixing the October books' });
  return { owner, seller: selling.seller.ctx, sellerId: selling.seller.account.id, store: selling.store, bag: selling.bag };
}
const anotherStore = async (owner: Ctx, seller: Ctx) => {
  const created = await aStore(seller, { creditMode: 'MONTHLY' });
  return decideStore(owner, created.id, 'approve', { version: created.version });
};
const bill = (owner: Ctx, storeId: string, amount: string, dueOn: string) => adjustBalance(owner, storeId, { amount, reason: 'Opening balance', dueOn });
const ledger = (owner: Ctx, storeId: string) => listStoreLedger(owner, storeId);
const owed = async (owner: Ctx, storeId: string) => (await getCreditStatus(owner, storeId)).outstanding;
const one = (rows: LedgerEntry[], pick: (e: LedgerEntry) => boolean): LedgerEntry => {
  const found = rows.filter(pick);
  if (found.length !== 1) throw new Error(`expected one ledger entry, found ${found.length}`);
  return found[0] as LedgerEntry;
};
const billOf = (amount: string) => (e: LedgerEntry) => e.entryType === 'ADJUSTMENT' && e.amount === amount && e.reference.type === 'ADJUSTMENT';
// A payment's own credit, not the debt a transfer that never arrived put back under its number.
const paymentNumbered = (number: string) => (e: LedgerEntry) => e.entryType === 'PAYMENT' && e.paymentNumber === number;

describe("store-account corrections: reversed and posted again, never overwritten (ADR-0059)", () => {
  it('COR-001, COR-002: nothing is corrected outside an open session, and each correction carries its own reason', async () => {
    const owner = await ctxFor(await anAccount('SUPER_ADMIN'));
    const { store } = await aSellingSeller(owner);
    await bill(owner, store.id, '120.00', '2026-09-01');
    const entry = one(await ledger(owner, store.id), billOf('120.00'));
    expect(await codeOf(correctStoreEntry(owner, entry.id, { amount: '100', reason: REASON }))).toBe('NO_CORRECTION_SESSION');
    expect(await codeOf(previewStoreCorrection(owner, entry.id, { amount: '100' }))).toBe('NO_CORRECTION_SESSION');
    await openCorrectionSession(owner, { password: PASSWORD, reason: 'Fixing the October books' });
    expect(await codeOf(correctStoreEntry(owner, entry.id, { amount: '100', reason: '  ' }))).toBe('REASON_REQUIRED');
    expect(await codeOf(correctStoreEntry(owner, entry.id, { amount: '120', reason: REASON }))).toBe('NOTHING_TO_CORRECT');
    const admin = await ctxFor(await anAccount('ADMIN'));
    expect(await codeOf(correctStoreEntry(admin, entry.id, { amount: '100', reason: REASON }))).toBe('FORBIDDEN');
  });

  it('COR-002, COR-005: a bill corrected — its effect shown first; the money paid towards it moves on; the original kept, struck through', async () => {
    const { owner, seller, store } = await setup();
    await bill(owner, store.id, '300.00', '2026-09-01');
    await bill(owner, store.id, '200.00', '2026-09-15');
    await recordPayment(seller, { storeId: store.id, ...(await paid(seller, '300.00')) }); // settles the older bill
    const original = one(await ledger(owner, store.id), billOf('300.00'));
    expect(await owed(owner, store.id)).toBe('200.00');

    // COR-002: the effect, before it is confirmed — and showing it changes nothing.
    const preview = await previewStoreCorrection(owner, original.id, { amount: '250' });
    expect(preview.stores).toEqual([expect.objectContaining({ id: store.id, owed: { before: '200.00', after: '150.00' } })]);
    expect(preview.cashInHand).toBeNull();
    expect(await ledger(owner, store.id)).toHaveLength(3);

    const { correction, effect } = await correctStoreEntry(owner, original.id, { amount: '250', reason: REASON });
    expect(effect).toEqual(preview);
    expect(correction).toMatchObject({ kind: 'BILL', reason: REASON, before: { amount: '300.00' }, after: { amount: '250.00', date: original.occurredAt && businessDate(original.occurredAt) } });
    expect(await owed(owner, store.id)).toBe('150.00');

    const rows = await ledger(owner, store.id);
    expect(one(rows, (e) => e.id === original.id)).toMatchObject({ replacedBy: { number: correction.number, reason: REASON, removed: false, movedTo: null }, correctable: null });
    expect(one(rows, (e) => e.reversalOf?.number === correction.number)).toMatchObject({ amount: '-300.00', correctable: null });
    const corrected = one(rows, (e) => e.correctionOf?.number === correction.number);
    // Paid in full by the money that paid the original; the rest of it went to the newer bill.
    expect(corrected).toMatchObject({ amount: '250.00', dueOn: '2026-09-01', open: '0.00', correctable: 'BILL', correctionOf: { was: { amount: '300.00', date: null } } });
    expect(one(rows, billOf('200.00')).open).toBe('150.00');
    expect(rows.at(-1)?.balance).toBe('150.00');
    // An entry is corrected once; a later correction corrects the corrected one.
    expect(await codeOf(correctStoreEntry(owner, original.id, { amount: '240', reason: REASON }))).toBe('ALREADY_CORRECTED');
    const [logged] = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.entityId, correction.id));
    expect(logged).toMatchObject({ action: 'corrections.store_entry_corrected', before: { amount: '300.00' } });
  });

  it('COR-005: a bill moved to the right store, due by its terms; removed; refused where it would leave a store in credit', async () => {
    const { owner, seller, store } = await setup();
    const other = await anotherStore(owner, seller);
    await bill(owner, store.id, '100.00', '2026-09-01');
    const moving = one(await ledger(owner, store.id), billOf('100.00'));
    const { correction } = await correctStoreEntry(owner, moving.id, { storeId: other.id, date: yesterday, reason: REASON });
    expect(correction.toStore).toEqual({ id: other.id, name: other.name });
    expect(await owed(owner, store.id)).toBe('0.00');
    expect(await owed(owner, other.id)).toBe('100.00');
    expect(one(await ledger(owner, store.id), (e) => e.id === moving.id).replacedBy).toMatchObject({ movedTo: other.name, removed: false });
    // Due by the other store's monthly terms, from the bill's corrected date.
    const arrived = one(await ledger(owner, other.id), (e) => e.correctionOf?.number === correction.number);
    expect(arrived).toMatchObject({ dueOn: `${yesterday.slice(0, 8)}${String(new Date(Date.UTC(Number(yesterday.slice(0, 4)), Number(yesterday.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`, correctionOf: { movedFrom: store.name, was: { date: today } } });

    // Paid in full, and nothing else owed: removing it would leave the store in credit.
    await bill(owner, store.id, '80.00', '2026-09-02');
    await recordPayment(seller, { storeId: store.id, ...(await paid(seller, '80.00')) });
    expect(await codeOf(correctStoreEntry(owner, one(await ledger(owner, store.id), billOf('80.00')).id, { remove: true, reason: REASON })))
      .toBe('CORRECTION_LEAVES_CREDIT');

    await bill(owner, store.id, '40.00', '2026-09-03');
    const removing = one(await ledger(owner, store.id), billOf('40.00'));
    const removed = await correctStoreEntry(owner, removing.id, { remove: true, reason: REASON });
    expect(removed.correction.after).toBeNull();
    expect(await owed(owner, store.id)).toBe('0.00');
    expect(one(await ledger(owner, store.id), (e) => e.id === removing.id).replacedBy).toMatchObject({ removed: true });
  });

  it('COR-005: a bill from a sale made in the app is corrected through the sale', async () => {
    const { owner, seller, store, bag } = await setup();
    await recordSale(seller, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }] });
    const sale = one(await ledger(owner, store.id), (e) => e.entryType === 'SALE');
    expect(sale.correctable).toBeNull();
    expect(await codeOf(correctStoreEntry(owner, sale.id, { amount: '80', reason: REASON }))).toBe('CORRECT_THROUGH_SALE');
  });

  it('COR-005: a cash payment corrected — the debts it paid put back and paid again; cash in hand moved only when chosen', async () => {
    const { owner, seller, sellerId, store } = await setup();
    await bill(owner, store.id, '500.00', '2026-09-01');
    const base = await cashInHand(getDb(), sellerId);
    const typo = await recordPayment(seller, { storeId: store.id, ...(await paid(seller, '300.00')) });
    const short = await recordPayment(seller, { storeId: store.id, ...(await paid(seller, '100.00')) });
    expect(await cashInHand(getDb(), sellerId)).toBe(dec(base).plus(400).toFixed(2));

    // The account only.
    const first = await correctStoreEntry(owner, one(await ledger(owner, store.id), paymentNumbered(typo.number)).id, { amount: '30', reason: REASON });
    expect(first.effect.cashInHand).toBeNull();
    expect(await owed(owner, store.id)).toBe('370.00');
    expect(await cashInHand(getDb(), sellerId)).toBe(dec(base).plus(400).toFixed(2));
    const replaced = await getDb().select().from(schema.payments).where(eq(schema.payments.id, typo.id));
    expect(replaced[0]?.supersededBy).toBe(first.correction.id);
    const [corrected] = await getDb().select().from(schema.payments).where(eq(schema.payments.correctionId, first.correction.id));
    expect(corrected).toMatchObject({ number: `${typo.number}-C${first.correction.number}`, amount: '30.00', voucherNumber: typo.voucher.number, receivedBy: sellerId, supersededBy: null });

    // And the collector's cash in hand, by the difference.
    const second = await correctStoreEntry(owner, one(await ledger(owner, store.id), paymentNumbered(short.number)).id, { amount: '150', cashInHand: true, reason: REASON });
    expect(second.effect.cashInHand).toMatchObject({ seller: { id: sellerId }, before: dec(base).plus(400).toFixed(2), after: dec(base).plus(450).toFixed(2) });
    expect(await owed(owner, store.id)).toBe('320.00');
    expect(second.correction.cashInHand).toBe(true);
    // Collections follow the payments that stand.
    const collected = (await collectedBySeller(getDb(), [sellerId], new Date(0), new Date(Date.now() + 86_400_000))).get(sellerId);
    expect(collected).toMatchObject({ cash: '180.00', payments: 2 });
    // Never below nothing.
    expect(await codeOf(inTx(owner, (tx) => postCashCorrection(tx, owner, {
      sellerId, amount: money('-999999.00'), referenceType: 'STORE_CORRECTION', referenceId: newId(),
    })))).toBe('CORRECTION_EXCEEDS_CASH_IN_HAND');
  });

  it('COR-005: a voucher number stays unique; a payment moved to its store; removed, its debts back by their own dates', async () => {
    const { owner, seller, store } = await setup();
    const other = await anotherStore(owner, seller);
    await bill(owner, store.id, '400.00', '2026-09-01');
    await bill(owner, other.id, '100.00', '2026-09-10');
    const p1 = await recordPayment(seller, { storeId: store.id, ...(await paid(seller, '100.00')) });
    const p2 = await recordPayment(seller, { storeId: store.id, ...(await paid(seller, '50.00')) });
    const p1Entry = one(await ledger(owner, store.id), paymentNumbered(p1.number));
    expect(await codeOf(correctStoreEntry(owner, p1Entry.id, { voucherNumber: p2.voucher.number, reason: REASON }))).toBe('DUPLICATE_VOUCHER');
    const renumbered = await correctStoreEntry(owner, p1Entry.id, { voucherNumber: `R-${p1.voucher.number}`, reason: REASON });
    expect(renumbered.correction.after?.voucherNumber).toBe(`R-${p1.voucher.number}`);
    // The number it gave up is free again.
    await recordPayment(seller, { storeId: store.id, amount: '10.00', method: 'CASH', voucher: { ...(await aVoucher(seller)), number: p1.voucher.number } });

    await correctStoreEntry(owner, one(await ledger(owner, store.id), paymentNumbered(p2.number)).id, { storeId: other.id, reason: REASON });
    expect(await owed(owner, store.id)).toBe('290.00');
    expect(await owed(owner, other.id)).toBe('50.00');

    const p1Now = one(await ledger(owner, store.id), (e) => e.correctionOf?.number === renumbered.correction.number);
    expect(p1Now.correctionOf?.was).toEqual({ amount: null, date: null, voucherNumber: p1.voucher.number });
    await correctStoreEntry(owner, p1Now.id, { remove: true, reason: REASON });
    expect(await owed(owner, store.id)).toBe('390.00');
    // What it had paid is owed again, by the date it was due.
    const back = (await ledger(owner, store.id)).filter((e) => e.reversalOf && e.amount === '100.00');
    expect(back.map((e) => e.dueOn)).toEqual(['2026-09-01', '2026-09-01']);
  });

  it('COR-005: a bank transfer is checked before it is corrected, and keeps its confirmation', async () => {
    const { owner, seller, sellerId, store, bag } = await setup({ creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    const approver = await ctxFor(await anAccount('ADMIN'));
    const sale = await recordSale(seller, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }], payment: await paid(seller, '90.00', 'BANK_TRANSFER', 'TRX-881') });
    if (!sale.payment) throw new Error('the sale was not paid');
    const entry = one(await ledger(owner, store.id), paymentNumbered(sale.payment.number));
    expect(await codeOf(correctStoreEntry(owner, entry.id, { voucherNumber: 'TV-1', reason: REASON }))).toBe('TRANSFER_NOT_DECIDED');
    await decideTransfer(approver, sale.payment.id, { outcome: 'CONFIRMED' });
    const { correction } = await correctStoreEntry(owner, entry.id, { voucherNumber: `TV-${sale.payment.voucher?.number ?? 'X'}`, reason: REASON });
    const [corrected] = await getDb().select({ id: schema.payments.id }).from(schema.payments).where(eq(schema.payments.correctionId, correction.id));
    const [kept] = await getDb().select().from(schema.transferDecisions).where(eq(schema.transferDecisions.paymentId, corrected?.id ?? ''));
    expect(kept).toMatchObject({ outcome: 'CONFIRMED', decidedBy: approver.user.id });
    expect((await listAwaitingTransfers(approver, { limit: 100 })).items.map((t) => t.id)).not.toContain(corrected?.id);
    // Counted once towards commission, at its corrected amount.
    const confirmed = (await confirmedTransfersFor(getDb(), [sellerId], 5)).get(sellerId);
    expect([...(confirmed?.values() ?? [])].reduce((t, v) => t.plus(dec(v)), dec('0')).toFixed(2)).toBe('90.00');

    // One that never arrived has left the account already.
    const second = await recordSale(seller, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1 }], payment: await paid(seller, '90.00', 'BANK_TRANSFER', 'TRX-882') });
    if (!second.payment) throw new Error('the sale was not paid');
    await decideTransfer(approver, second.payment.id, { outcome: 'NOT_RECEIVED', reason: 'Not on the statement' });
    const lost = one(await ledger(owner, store.id), paymentNumbered(second.payment.number));
    expect(await codeOf(correctStoreEntry(owner, lost.id, { amount: '80', reason: REASON }))).toBe('NOT_CORRECTABLE');
  });

  it('COR-002: a replaced payment is marked once and otherwise unchanged; corrections themselves never change', async () => {
    const { owner, seller, store } = await setup();
    await bill(owner, store.id, '60.00', '2026-09-01');
    const payment = await recordPayment(seller, { storeId: store.id, ...(await paid(seller, '60.00')) });
    const { correction } = await correctStoreEntry(owner, one(await ledger(owner, store.id), paymentNumbered(payment.number)).id, { amount: '50', reason: REASON });
    for (const [statement, code] of [
      [sql`update payments set superseded_by = null where id = ${payment.id}`, '23514'],
      [sql`update payments set amount = 1 where id = ${payment.id}`, '42501'],
      [sql`update store_corrections set reason = 'Something else' where id = ${correction.id}`, '42501'],
      [sql`delete from store_corrections where id = ${correction.id}`, '42501'],
    ] as const) expect(await pgCode(getDb().execute(statement))).toBe(code);
    const [still] = await getDb().select().from(schema.payments).where(and(eq(schema.payments.id, payment.id), eq(schema.payments.amount, '60.00')));
    expect(still?.supersededBy).toBe(correction.id);
  });

  it('COR-002: the Corrections page lists each correction with its session, newest first', async () => {
    const { owner, store } = await setup();
    await bill(owner, store.id, '70.00', '2026-09-01');
    const { correction } = await correctStoreEntry(owner, one(await ledger(owner, store.id), billOf('70.00')).id, { amount: '75', reason: REASON });
    const admin = await ctxFor(await anAccount('ADMIN'));
    const page = await listStoreCorrections(admin, { limit: 200 });
    const numbers = page.items.map((c) => c.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    expect(page.items.find((c) => c.id === correction.id)).toMatchObject({
      store: { id: store.id, name: store.name }, before: { amount: '70.00' }, after: { amount: '75.00' }, reason: REASON,
    });
    const manager = await ctxFor(await anAccount('MANAGER'));
    expect(await codeOf(listStoreCorrections(manager))).toBe('FORBIDDEN');
  });
});
