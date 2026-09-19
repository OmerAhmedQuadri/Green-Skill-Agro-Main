import { dec, DomainError, toMoney, type Money } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq, sql } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { syncFlagsFor } from './ceilings';
import type { Executor, Tx } from '../platform';
import { getDb } from '../runtime';

const { cashLedgerEntries } = schema;

/**
 * CSH-001 (DATA-MODEL §3.3, ADR-0037): cash taken at a store raises the
 * collector's cash in hand, in the transaction that took it.
 */
export async function postCashCollection(
  tx: Tx, ctx: Ctx, input: { sellerId: string; amount: Money; referenceType: 'PAYMENT'; referenceId: string },
): Promise<void> {
  await tx.insert(cashLedgerEntries).values({
    sellerId: input.sellerId, occurredAt: ctx.now, entryType: 'COLLECTION', amount: input.amount,
    referenceType: input.referenceType, referenceId: input.referenceId, branchId: ctx.branchId, createdBy: ctx.user.id,
  });
  // LIM-002: collecting can take the seller over their cash ceiling.
  await syncFlagsFor(tx, ctx, input.sellerId);
}

/**
 * RET-008, OQ-020 (ADR-0039): the seller hands cash back to a store on a
 * credit note — out of their cash in hand, never more than they hold.
 */
/** One seller's cash ledger at a time: refunds and settlements read then write it. */
export const lockCash = (tx: Executor, sellerId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cash-ledger:${sellerId}`}, 0))`);

export async function postCashRefund(
  tx: Tx, ctx: Ctx, input: { sellerId: string; amount: Money; referenceType: 'RETURN'; referenceId: string },
): Promise<string> {
  await lockCash(tx, input.sellerId);
  const held = await cashInHand(tx, input.sellerId);
  if (dec(input.amount).gt(dec(held))) throw new DomainError('REFUND_EXCEEDS_CASH_IN_HAND', { amount: input.amount, cashInHand: held });
  const [row] = await tx.insert(cashLedgerEntries).values({
    sellerId: input.sellerId, occurredAt: ctx.now, entryType: 'REFUND', amount: toMoney(dec(input.amount).negated()),
    referenceType: input.referenceType, referenceId: input.referenceId, branchId: ctx.branchId, createdBy: ctx.user.id,
  }).returning({ id: cashLedgerEntries.id });
  if (!row) throw new Error('cash ledger insert returned nothing');
  return row.id;
}

/** Cash in hand: the sum of the seller's cash ledger. */
export async function cashInHand(db: Executor, sellerId: string): Promise<Money> {
  const [row] = await db.select({ total: sql<string>`coalesce(sum(${cashLedgerEntries.amount}), 0)::numeric(14,2)` })
    .from(cashLedgerEntries).where(eq(cashLedgerEntries.sellerId, sellerId));
  return (row?.total ?? '0.00') as Money;
}

/** CSH-001, SAL-007: the seller's own cash in hand. */
export async function getMyCashInHand(ctx: Ctx): Promise<{ readonly cashInHand: Money }> {
  authorize(ctx, 'cash.submit_settlement');
  if (ctx.user.role !== 'SELLER') throw new DomainError('FORBIDDEN', { permission: 'cash.submit_settlement' });
  return { cashInHand: await cashInHand(ctx.tx ?? getDb(), ctx.user.id) };
}
