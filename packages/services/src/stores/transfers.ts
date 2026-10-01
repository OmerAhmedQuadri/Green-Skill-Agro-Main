import { assertTransferDecision, DomainError, type Money, type TransferOutcome } from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { notify } from '../notifications';
import { audit, inTx, type Executor, type Tx } from '../platform';
import { getDb } from '../runtime';
import { postStoreDebit } from './credit';

const { payments, paymentAllocations, storeLedgerEntries, stores, transferDecisions, users } = schema;

export type AwaitingTransfer = {
  readonly id: string; readonly number: string; readonly amount: Money; readonly reference: string; readonly receivedAt: Date;
  /** ADR-0047: the voucher handed over for it, to check with the statement. */ readonly voucher: { readonly number: string; readonly photoId: string } | null;
  readonly store: { readonly id: string; readonly name: string };
  readonly seller: { readonly id: string; readonly name: string };
  /** False for a transfer the caller recorded themselves: someone else decides it (four eyes). */
  readonly decidable: boolean;
};

/** A store's bank transfer nobody has decided on yet. */
const awaiting = and(eq(payments.method, 'BANK_TRANSFER'), isNull(transferDecisions.id));

/**
 * ADR-0046: the bank transfers nobody has checked yet, oldest first — the list
 * an approver works through against the bank statement — and how many there
 * are in all.
 */
export async function listAwaitingTransfers(ctx: Ctx, filter: { limit?: number | undefined } = {}): Promise<{ items: AwaitingTransfer[]; total: number }> {
  authorize(ctx, 'cash.approve_settlement');
  const db = ctx.tx ?? getDb();
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
  const rows = await db.select({
    id: payments.id, number: payments.number, amount: payments.amount, reference: payments.reference, receivedAt: payments.receivedAt,
    voucherNumber: payments.voucherNumber, voucherPhotoId: payments.voucherPhotoId,
    storeId: stores.id, storeName: stores.name, sellerId: users.id, sellerName: users.name,
  }).from(payments)
    .innerJoin(stores, eq(stores.id, payments.storeId))
    .innerJoin(users, eq(users.id, payments.receivedBy))
    .leftJoin(transferDecisions, eq(transferDecisions.paymentId, payments.id))
    .where(awaiting)
    .orderBy(asc(payments.receivedAt), asc(payments.id))
    .limit(limit);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(payments)
    .leftJoin(transferDecisions, eq(transferDecisions.paymentId, payments.id)).where(awaiting);
  return {
    items: rows.map((r) => ({
      id: r.id, number: r.number, amount: r.amount as Money, reference: r.reference ?? '', receivedAt: r.receivedAt,
      voucher: r.voucherNumber && r.voucherPhotoId ? { number: r.voucherNumber, photoId: r.voucherPhotoId } : null,
      store: { id: r.storeId, name: r.storeName }, seller: { id: r.sellerId, name: r.sellerName }, decidable: r.sellerId !== ctx.user.id,
    })),
    total: count?.n ?? 0,
  };
}

/**
 * ADR-0046: what each seller has collected by bank transfer that nobody has
 * confirmed yet — money that earns nothing until someone does. Every seller
 * asked for is in the result, at zero if nothing is waiting.
 */
export async function transfersAwaitingBy(db: Executor, sellerIds: readonly string[]): Promise<Map<string, Money>> {
  const out = new Map<string, Money>(sellerIds.map((id) => [id, '0.00' as Money]));
  if (sellerIds.length === 0) return out;
  const rows = await db.select({ sellerId: payments.receivedBy, amount: sql<string>`coalesce(sum(${payments.amount}), 0)::numeric(14,2)` })
    .from(payments).leftJoin(transferDecisions, eq(transferDecisions.paymentId, payments.id))
    .where(and(awaiting, inArray(payments.receivedBy, [...sellerIds])))
    .groupBy(payments.receivedBy);
  for (const row of rows) out.set(row.sellerId, row.amount as Money);
  return out;
}

export type TransferDecision = {
  readonly id: string; readonly paymentId: string; readonly outcome: TransferOutcome; readonly reason: string | null;
  readonly decidedAt: Date; readonly decidedBy: string;
};

/**
 * ADR-0046: a transfer that never arrived puts back what it had settled — one
 * debit for each due date it cleared, so the store owes what it did before, by
 * the same dates, and its credit rules apply again at once (CRD-005).
 */
async function reinstateDebts(tx: Tx, ctx: Ctx, payment: { id: string; storeId: string; ledgerEntryId: string }, reason: string): Promise<void> {
  const cleared = await tx.select({ dueOn: storeLedgerEntries.dueOn, amount: sql<string>`sum(${paymentAllocations.amount})::numeric(14,2)` })
    .from(paymentAllocations)
    .innerJoin(storeLedgerEntries, eq(storeLedgerEntries.id, paymentAllocations.debitEntryId))
    .where(eq(paymentAllocations.creditEntryId, payment.ledgerEntryId))
    .groupBy(storeLedgerEntries.dueOn)
    .orderBy(asc(storeLedgerEntries.dueOn));
  for (const debt of cleared) {
    await postStoreDebit(tx, ctx, {
      storeId: payment.storeId, entryType: 'ADJUSTMENT', amount: debt.amount as Money,
      referenceType: 'TRANSFER_NOT_RECEIVED', referenceId: payment.id, note: reason, dueOn: debt.dueOn,
    });
  }
}

/**
 * ADR-0046: an approver checks a store's bank transfer against the account.
 * Confirmed, it counts towards the seller's collections and commission, in the
 * month it was received. Not received, the store owes the money again and the
 * seller who recorded it is told. Either way it is final.
 */
export async function decideTransfer(
  ctx: Ctx, paymentId: string, input: { outcome: TransferOutcome; reason?: string | null | undefined },
): Promise<TransferDecision> {
  authorize(ctx, 'cash.approve_settlement');
  const reason = input.reason?.trim() || null;
  return inTx(ctx, async (tx) => {
    // Two approvers deciding at once take turns, and the second finds it decided. An advisory
    // lock, because payments are append-only: the runtime role cannot lock their rows.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`transfer:${paymentId}`}, 0))`);
    const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId));
    if (!payment || payment.method !== 'BANK_TRANSFER') throw new DomainError('NOT_FOUND', { entity: 'transfer', id: paymentId });
    const [earlier] = await tx.select({ id: transferDecisions.id }).from(transferDecisions).where(eq(transferDecisions.paymentId, paymentId));
    assertTransferDecision({ decided: earlier !== undefined, recordedBy: payment.receivedBy, decidedBy: ctx.user.id, outcome: input.outcome, reason });

    const id = newId();
    await tx.insert(transferDecisions).values({
      id, paymentId, outcome: input.outcome, reason, decidedAt: ctx.now, decidedBy: ctx.user.id, branchId: ctx.branchId,
    });
    if (input.outcome === 'NOT_RECEIVED') {
      await reinstateDebts(tx, ctx, payment, reason ?? '');
      const [recorder] = await tx.select({ role: users.role }).from(users).where(eq(users.id, payment.receivedBy));
      const area = recorder?.role === 'SELLER' ? 'field' : 'console';
      await notify(tx, ctx, { users: [payment.receivedBy] }, 'TRANSFER_NOT_RECEIVED',
        { number: payment.number, amount: payment.amount, reason }, `/${area}/stores/${payment.storeId}`);
    }
    await audit(tx, ctx, {
      action: input.outcome === 'CONFIRMED' ? 'cash.transfer_confirmed' : 'cash.transfer_not_received',
      entityType: 'payment', entityId: paymentId, after: { number: payment.number, amount: payment.amount, outcome: input.outcome, reason },
    });
    return { id, paymentId, outcome: input.outcome, reason, decidedAt: ctx.now, decidedBy: ctx.user.id };
  });
}
