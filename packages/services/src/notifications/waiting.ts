import { decisionQueuesFor, type DecisionQueue } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, gt, isNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Ctx } from '../context';
import { getDb } from '../runtime';

const {
  stores, sales, discountApprovalRequests, writeOffs, purchaseOrders, cashSettlements, payments, transferDecisions,
  lostOrderClaims, dispatchOrders, attendanceSessions, closingStockDeclarations,
} = schema;

export type WaitingQueue = { readonly queue: DecisionQueue; readonly count: number };

/**
 * ADR-0051 (SYS-016): what waits for a decision the reader can make, counted
 * from the records each time it is asked, so it is never stale. Only the
 * queues they hold the permission for, and in each only what they may decide:
 * never their own submission (four-eyes), never a cash handover meant for
 * another manager (ADR-0040).
 */
export async function waitingForDecision(ctx: Ctx): Promise<WaitingQueue[]> {
  const db = getDb();
  const n = sql<number>`count(*)::int`;
  // Some records were created by nobody in particular (imported, or by the system).
  const notMine = (column: AnyColumn): SQL => sql`${column} is distinct from ${ctx.user.id}`;
  const count = async (rows: Promise<{ n: number }[]>) => (await rows)[0]?.n ?? 0;
  // As the sales list's "awaiting a decision"; past its time, nobody can decide it.
  const requests = (kind: 'DISCOUNT' | 'OPEN_SALE') => count(db.select({ n }).from(discountApprovalRequests)
    .innerJoin(sales, eq(sales.id, discountApprovalRequests.saleId)).where(and(
      eq(discountApprovalRequests.kind, kind), eq(discountApprovalRequests.status, 'PENDING'), gt(discountApprovalRequests.expiresAt, ctx.now),
      notMine(sales.sellerId), notMine(sales.createdBy),
    )));

  const counters: Record<DecisionQueue, () => Promise<number>> = {
    DISCOUNTS: () => requests('DISCOUNT'),
    // ADR-0052: the same requests, of the other kind.
    OPEN_SALES: () => requests('OPEN_SALE'),
    CHECK_INS: () => count(db.select({ n }).from(attendanceSessions).where(eq(attendanceSessions.status, 'AWAITING_AUTHORISATION'))),
    DISPATCH: () => count(db.select({ n }).from(dispatchOrders).where(eq(dispatchOrders.status, 'REQUESTED'))),
    STORES: () => count(db.select({ n }).from(stores).where(and(eq(stores.status, 'PENDING_APPROVAL'), notMine(stores.createdBy)))),
    SETTLEMENTS: () => count(db.select({ n }).from(cashSettlements).where(and(
      eq(cashSettlements.status, 'SUBMITTED'), notMine(cashSettlements.sellerId),
      or(sql`${cashSettlements.route} <> 'MANAGER_HANDOVER'`, eq(cashSettlements.receivedBy, ctx.user.id)),
    ))),
    TRANSFERS: () => count(db.select({ n }).from(payments).leftJoin(transferDecisions, eq(transferDecisions.paymentId, payments.id)).where(and(
      eq(payments.method, 'BANK_TRANSFER'), isNull(transferDecisions.id), notMine(payments.receivedBy),
    ))),
    LOST_CLAIMS: () => count(db.select({ n }).from(lostOrderClaims).innerJoin(dispatchOrders, eq(dispatchOrders.id, lostOrderClaims.orderId)).where(and(
      eq(lostOrderClaims.status, 'PENDING'), notMine(lostOrderClaims.raisedBy), notMine(dispatchOrders.sellerId),
    ))),
    WRITE_OFFS: () => count(db.select({ n }).from(writeOffs).where(and(eq(writeOffs.status, 'SUBMITTED'), notMine(writeOffs.submittedBy)))),
    PURCHASE_ORDERS: () => count(db.select({ n }).from(purchaseOrders).where(eq(purchaseOrders.status, 'PENDING_APPROVAL'))),
    CLOSING_VARIANCES: () => count(db.select({ n }).from(closingStockDeclarations).where(eq(closingStockDeclarations.status, 'VARIANCE_FLAGGED'))),
  };
  const queues = decisionQueuesFor(ctx.permissions);
  const counts = await Promise.all(queues.map((q) => counters[q]()));
  return queues.map((queue, i) => ({ queue, count: counts[i] ?? 0 }));
}
