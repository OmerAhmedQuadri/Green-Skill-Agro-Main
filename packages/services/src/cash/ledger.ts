import { DomainError, type Money } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq, sql } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
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
