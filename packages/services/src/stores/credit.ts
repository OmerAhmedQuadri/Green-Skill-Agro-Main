import {
  allocateCredit, businessDate, dec, DomainError, dueDateFor, isoDate, money, toMoney, type CreditStatus, type Money,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { aliasedTable, and, asc, eq, isNull, sql } from 'drizzle-orm';
import { assertSellerWorking } from '../attendance';
import { authorize, authorizeAny, type Ctx } from '../context';
import { notify } from '../notifications';
import { audit, inTx, nextDocumentNumber, type Executor, type Tx } from '../platform';
import { getDb } from '../runtime';
import { loadStore, openDebits, readingAsManager } from './access';

const { stores, storeLedgerEntries, paymentAllocations, payments, creditOverrides, storeAssignments, users } = schema;

const lockLedger = (tx: Tx, storeId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`store-ledger:${storeId}`}, 0))`);

/**
 * A debit on the store ledger: + what the store owes, due by its cycle when
 * posted (ADR-0036) unless a due date is given. Sales post through here (M6).
 */
export async function postStoreDebit(
  tx: Tx, ctx: Ctx,
  input: { storeId: string; entryType: 'SALE' | 'ADJUSTMENT'; amount: Money; referenceType: string; referenceId: string; note?: string | null; dueOn?: string | null },
): Promise<{ entryId: string; dueOn: string }> {
  await lockLedger(tx, input.storeId);
  const [store] = await tx.select({ mode: stores.creditMode, days: stores.creditCycleDays }).from(stores).where(eq(stores.id, input.storeId));
  if (!store) throw new DomainError('NOT_FOUND', { entity: 'store', id: input.storeId });
  const dueOn = input.dueOn ?? dueDateFor(store.mode, store.days, businessDate(ctx.now));
  const [row] = await tx.insert(storeLedgerEntries).values({
    storeId: input.storeId, occurredAt: ctx.now, entryType: input.entryType, amount: input.amount, dueOn,
    referenceType: input.referenceType, referenceId: input.referenceId, note: input.note ?? null, branchId: ctx.branchId, createdBy: ctx.user.id,
  }).returning({ id: storeLedgerEntries.id });
  if (!row) throw new Error('ledger insert returned nothing');
  return { entryId: row.id, dueOn };
}

/**
 * A credit on the store ledger — a payment, a credit note, a downward
 * adjustment — settling the oldest due debts first (CRD-003). It cannot
 * exceed what is owed; the database re-checks at commit.
 */
export async function postStoreCredit(
  tx: Tx, ctx: Ctx,
  input: { storeId: string; entryType: 'PAYMENT' | 'CREDIT_NOTE' | 'ADJUSTMENT'; amount: Money; referenceType: string; referenceId: string; note?: string | null },
): Promise<{ entryId: string; allocations: { debitId: string; amount: Money }[] }> {
  await lockLedger(tx, input.storeId);
  const allocations = allocateCredit(input.amount, await openDebits(tx, [input.storeId]));
  const [row] = await tx.insert(storeLedgerEntries).values({
    storeId: input.storeId, occurredAt: ctx.now, entryType: input.entryType, amount: toMoney(dec(input.amount).negated()),
    referenceType: input.referenceType, referenceId: input.referenceId, note: input.note ?? null, branchId: ctx.branchId, createdBy: ctx.user.id,
  }).returning({ id: storeLedgerEntries.id });
  if (!row) throw new Error('ledger insert returned nothing');
  await tx.insert(paymentAllocations).values(allocations.map((a) => ({ creditEntryId: row.id, debitEntryId: a.debitId, amount: a.amount })));
  return { entryId: row.id, allocations };
}

export type Payment = {
  readonly id: string; readonly number: string; readonly storeId: string; readonly amount: Money; readonly method: 'CASH' | 'BANK_TRANSFER';
  readonly reference: string | null; readonly receivedAt: Date; readonly receivedBy: string; readonly credit: CreditStatus;
};

/**
 * CRD-003: a payment collected from a store — partial or in full, oldest
 * debts first, the rest carrying forward. A seller collects during an open
 * day (ATT-010), from the stores they manage. The cash ledger joins in M7.
 */
export async function recordPayment(
  ctx: Ctx, input: { storeId: string; amount: string; method: 'CASH' | 'BANK_TRANSFER'; reference?: string | null | undefined },
): Promise<Payment> {
  authorize(ctx, 'sales.record');
  const amount = money(input.amount);
  const reference = input.reference?.trim() || null;
  if (input.method === 'BANK_TRANSFER' && !reference) throw new DomainError('REASON_REQUIRED', { field: 'reference' });
  return inTx(ctx, async (tx) => {
    await assertSellerWorking(tx, ctx);
    await loadStore(tx, ctx, input.storeId); // the seller's own store, or view_all
    const id = newId();
    const { entryId } = await postStoreCredit(tx, ctx, { storeId: input.storeId, entryType: 'PAYMENT', amount, referenceType: 'PAYMENT', referenceId: id });
    const number = await nextDocumentNumber(tx, 'PM', ctx.now);
    await tx.insert(payments).values({
      id, number, storeId: input.storeId, amount, method: input.method, reference, receivedAt: ctx.now, receivedBy: ctx.user.id,
      ledgerEntryId: entryId, branchId: ctx.branchId,
    });
    // TODO(M7): a cash payment raises the seller's cash in hand (CSH-001).
    await audit(tx, ctx, { action: 'stores.payment_recorded', entityType: 'payment', entityId: id, after: { number, storeId: input.storeId, amount, method: input.method } });
    const store = await loadStore(tx, ctx, input.storeId);
    return { id, number, storeId: input.storeId, amount, method: input.method, reference, receivedAt: ctx.now, receivedBy: ctx.user.id, credit: store.credit };
  });
}

/**
 * ADR-0036: a manager's correction, with a reason — up (owed more, due by the
 * cycle or on a given date) or down (settling the oldest debts). Opening
 * balances at go-live arrive this way, with their real due dates.
 */
export async function adjustBalance(
  ctx: Ctx, storeId: string, input: { amount: string; reason: string; dueOn?: string | null | undefined },
): Promise<CreditStatus> {
  authorize(ctx, 'stores.adjust_balance');
  const reason = input.reason.trim();
  if (!reason) throw new DomainError('REASON_REQUIRED', { action: 'adjust' });
  const signed = input.amount.trim();
  const up = !signed.startsWith('-');
  const amount = money(up ? signed.replace(/^\+/, '') : signed.slice(1));
  if (!dec(amount).gt(0)) throw new DomainError('INVALID_MONEY', { value: input.amount });
  const dueOn = input.dueOn ? isoDate(input.dueOn, 'dueOn') : null;
  return inTx(ctx, async (tx) => {
    await loadStore(tx, readingAsManager(ctx), storeId);
    const id = newId();
    if (up) await postStoreDebit(tx, ctx, { storeId, entryType: 'ADJUSTMENT', amount, referenceType: 'ADJUSTMENT', referenceId: id, note: reason, dueOn });
    else await postStoreCredit(tx, ctx, { storeId, entryType: 'ADJUSTMENT', amount, referenceType: 'ADJUSTMENT', referenceId: id, note: reason });
    await audit(tx, ctx, { action: 'stores.balance_adjusted', entityType: 'store', entityId: storeId, after: { amount: up ? amount : `-${amount}`, reason, dueOn } });
    return (await loadStore(tx, readingAsManager(ctx), storeId)).credit;
  });
}

/** CRD-005: why a store may or may not be sold to, now — checked before any item is added. */
export async function getCreditStatus(ctx: Ctx, storeId: string): Promise<CreditStatus> {
  authorizeAny(ctx, ['stores.onboard', 'stores.view_all']);
  return (await loadStore(ctx.tx ?? getDb(), ctx, storeId)).credit;
}

/**
 * CRD-006, CRD-007 (OQ-018): a manager with delegated authority releases a
 * store blocked on credit for one sale today, with a reason. It never
 * releases a store that is not approved or not active.
 */
export async function grantCreditOverride(ctx: Ctx, storeId: string, input: { reason: string }): Promise<CreditStatus> {
  authorize(ctx, 'stores.override_credit_block');
  const reason = input.reason.trim();
  if (!reason) throw new DomainError('REASON_REQUIRED', { action: 'override' });
  return inTx(ctx, async (tx) => {
    const all = readingAsManager(ctx);
    const store = await loadStore(tx, all, storeId);
    if (store.status !== 'ACTIVE') throw new DomainError('STORE_NOT_ACTIVE', { status: store.status });
    if (!store.credit.blocked || store.credit.reasons.length === 0) throw new DomainError('NOT_BLOCKED');
    await tx.insert(creditOverrides).values({
      storeId, reason, businessDate: businessDate(ctx.now), grantedAt: ctx.now, grantedBy: ctx.user.id, branchId: ctx.branchId,
    }).onConflictDoNothing();
    const [assigned] = await tx.select({ sellerId: storeAssignments.sellerId }).from(storeAssignments)
      .where(and(eq(storeAssignments.storeId, storeId), isNull(storeAssignments.endedAt)));
    if (assigned) await notify(tx, ctx, { users: [assigned.sellerId] }, 'CREDIT_OVERRIDE_GRANTED', { name: store.name, reason }, `/field/stores/${storeId}`);
    await audit(tx, ctx, { action: 'stores.credit_override_granted', entityType: 'store', entityId: storeId, after: { reason, reasons: store.credit.reasons } });
    return (await loadStore(tx, all, storeId)).credit;
  });
}

/** M6: the sale that uses today's override marks it used, so it covers one sale only. */
export async function consumeCreditOverride(tx: Executor, ctx: Ctx, storeId: string, saleId: string): Promise<boolean> {
  const used = await tx.update(creditOverrides).set({ usedAt: ctx.now, usedReferenceId: saleId })
    .where(and(eq(creditOverrides.storeId, storeId), eq(creditOverrides.businessDate, businessDate(ctx.now)), isNull(creditOverrides.usedAt)))
    .returning({ id: creditOverrides.id });
  return used.length > 0;
}

export type LedgerEntry = {
  readonly id: string; readonly occurredAt: Date; readonly entryType: 'SALE' | 'PAYMENT' | 'CREDIT_NOTE' | 'ADJUSTMENT';
  readonly amount: Money; readonly balance: Money; readonly dueOn: string | null; readonly open: Money | null;
  readonly note: string | null; readonly paymentNumber: string | null; readonly by: string;
};

/** RPT-008, CRD-003: the store's ledger, oldest first, with the running balance and what each debt still owes. */
export async function listStoreLedger(ctx: Ctx, storeId: string): Promise<LedgerEntry[]> {
  authorizeAny(ctx, ['stores.onboard', 'stores.view_all']);
  const db = getDb();
  await loadStore(db, ctx, storeId);
  const by = aliasedTable(users, 'by');
  const rows = await db.select({
    e: storeLedgerEntries, byName: by.name, paymentNumber: payments.number,
    settled: sql<string>`coalesce((select sum(${paymentAllocations.amount}) from ${paymentAllocations} where ${paymentAllocations.debitEntryId} = ${storeLedgerEntries.id}), 0)`,
  }).from(storeLedgerEntries)
    .innerJoin(by, eq(by.id, storeLedgerEntries.createdBy))
    .leftJoin(payments, eq(payments.ledgerEntryId, storeLedgerEntries.id))
    .where(eq(storeLedgerEntries.storeId, storeId))
    .orderBy(asc(storeLedgerEntries.occurredAt), asc(storeLedgerEntries.id));
  let running = dec('0');
  return rows.map((r) => {
    running = running.plus(dec(r.e.amount));
    const debit = dec(r.e.amount).gt(0);
    return {
      id: r.e.id, occurredAt: r.e.occurredAt, entryType: r.e.entryType, amount: r.e.amount as Money, balance: toMoney(running),
      dueOn: r.e.dueOn, open: debit ? toMoney(dec(r.e.amount).minus(dec(r.settled))) : null, note: r.e.note,
      paymentNumber: r.paymentNumber, by: r.byName,
    };
  });
}
