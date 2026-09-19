import { dec, DomainError, toMoney, type Money } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { postCashRefund, syncFlagsFor } from '../cash';
import { authorize, type Ctx } from '../context';
import { audit, inTx, type Executor } from '../platform';
import { getDb } from '../runtime';

const { refundPayments, returns, stores } = schema;

export type RefundDue = {
  readonly returnId: string; readonly number: string; readonly store: { readonly id: string; readonly name: string };
  readonly outstanding: Money; readonly raisedAt: Date;
};

const paid = sql<string>`coalesce((select sum(${refundPayments.amount}) from ${refundPayments} where ${refundPayments.returnId} = ${returns.id}), 0)`;

/**
 * OQ-012: money a manager's credit note left owed to a store. The seller
 * hands it over on a later visit, out of their cash in hand.
 */
export async function refundsDue(db: Executor, sellerId: string): Promise<RefundDue[]> {
  const rows = await db.select({ id: returns.id, number: returns.number, storeId: returns.storeId, name: stores.name, occurredAt: returns.occurredAt, outstanding: sql<string>`(${returns.refundDue} - ${paid})::numeric(14,2)` })
    .from(returns).innerJoin(stores, eq(stores.id, returns.storeId))
    .where(and(eq(returns.sellerId, sellerId), gt(returns.refundDue, '0'), sql`${returns.refundDue} > ${paid}`))
    .orderBy(asc(returns.occurredAt));
  return rows.map((r) => ({
    returnId: r.id, number: r.number, store: { id: r.storeId, name: r.name }, outstanding: r.outstanding as Money, raisedAt: r.occurredAt,
  }));
}

/** The seller's own list, for the cash screen. */
export async function myRefundsDue(ctx: Ctx): Promise<RefundDue[]> {
  authorize(ctx, 'returns.process');
  return refundsDue(ctx.tx ?? getDb(), ctx.user.id);
}

/**
 * OQ-012: the seller hands the money over and records it — a cash refund out
 * of their cash in hand, refused if they are not carrying enough.
 */
export async function payRefundDue(ctx: Ctx, returnId: string): Promise<RefundDue[]> {
  authorize(ctx, 'returns.process');
  return inTx(ctx, async (tx) => {
    // `returns` is append-only, so no row lock: one refund at a time per return.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`refund-due:${returnId}`}, 0))`);
    const [row] = await tx.select({ sellerId: returns.sellerId, number: returns.number, outstanding: sql<string>`(${returns.refundDue} - ${paid})::numeric(14,2)` })
      .from(returns).where(eq(returns.id, returnId));
    if (!row || row.sellerId !== ctx.user.id) throw new DomainError('NOT_FOUND', { entity: 'return', id: returnId });
    const outstanding = toMoney(dec(row.outstanding));
    if (!dec(outstanding).gt(0)) throw new DomainError('ALREADY_DECIDED', { entity: 'refund', id: returnId });
    const cashEntryId = await postCashRefund(tx, ctx, { sellerId: ctx.user.id, amount: outstanding, referenceType: 'RETURN', referenceId: returnId });
    await tx.insert(refundPayments).values({
      returnId, sellerId: ctx.user.id, amount: outstanding, cashLedgerEntryId: cashEntryId, paidAt: ctx.now, branchId: ctx.branchId,
    });
    await syncFlagsFor(tx, ctx, ctx.user.id);
    await audit(tx, ctx, { action: 'returns.refund_paid', entityType: 'return', entityId: returnId, after: { number: row.number, amount: outstanding } });
    return refundsDue(tx, ctx.user.id);
  });
}
