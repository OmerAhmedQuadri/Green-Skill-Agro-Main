import { businessDate, HOLDING_SALE_STATUSES } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { endRequest } from '../notifications';
import { writeAudit, type Tx } from '../platform';
import { defaultBranchId, getDb } from '../runtime';

// Imports nothing from attendance: check-out calls in here.
const { sales, discountApprovalRequests, notifications, stores } = schema;

type Origin = { actorId: string | null; branchId: string; requestId: string | null; ip: string | null };

type Expiring = { id: string; sellerId: string; storeName: string | null; open: boolean };

/** PRC-015: the sales stop holding stock; a request still undecided is marked expired. */
async function expire(tx: Tx, rows: readonly Expiring[], now: Date, origin: Origin, notifySeller: boolean) {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  await tx.update(sales).set({ status: 'CANCELLED', cancelReason: 'EXPIRED', cancelledAt: now, updatedAt: now, updatedBy: origin.actorId, version: sql`${sales.version} + 1` })
    .where(inArray(sales.id, ids));
  await tx.update(discountApprovalRequests)
    .set({ status: sql`case when ${discountApprovalRequests.status} = 'PENDING' then 'EXPIRED'::discount_request_status else ${discountApprovalRequests.status} end`, closedAt: now })
    .where(inArray(discountApprovalRequests.saleId, ids));
  // ADR-0051: an approved sale lapsing ended its request already; this ends only those still waiting.
  await endRequest(tx, 'DISCOUNT_APPROVAL_REQUESTED', ids, 'EXPIRED', origin.actorId, now);
  await endRequest(tx, 'OPEN_SALE_REQUESTED', ids, 'EXPIRED', origin.actorId, now);
  if (notifySeller) {
    await tx.insert(notifications).values(rows.map((r) => ({
      userId: r.sellerId, kind: r.open ? 'OPEN_SALE_EXPIRED' as const : 'DISCOUNT_EXPIRED' as const, params: { store: r.storeName ?? '' },
      link: `/field/sales/${r.id}`, createdAt: now, branchId: origin.branchId,
    })));
  }
  await writeAudit(tx, origin, { action: 'sales.expired', entityType: 'sale', after: { sales: ids } });
}

/** PRC-015: at check-out every request of the seller's expires, and an approved sale not completed lapses. */
export async function expireSellerSales(tx: Tx, ctx: Ctx): Promise<number> {
  const rows = await tx.select({ id: sales.id, sellerId: sales.sellerId, storeName: stores.name, open: sql<boolean>`${sales.storeId} is null` }).from(sales)
    .leftJoin(stores, eq(stores.id, sales.storeId))
    .where(and(eq(sales.sellerId, ctx.user.id), inArray(sales.status, [...HOLDING_SALE_STATUSES]))).for('update', { of: sales });
  await expire(tx, rows, ctx.now, { actorId: ctx.user.id, branchId: ctx.branchId, requestId: ctx.requestId, ip: ctx.ip }, false);
  return rows.length;
}

/**
 * Worker job `discount-approval.expire`, every minute (ARCHITECTURE §6.5):
 * undecided requests past their time, and approved sales left from an earlier
 * business day. Rows another pass is handling are skipped. Idempotent.
 */
export async function expireDiscountRequests(now: Date): Promise<{ expired: number }> {
  return getDb().transaction(async (tx) => {
    const rows = await tx.select({ id: sales.id, sellerId: sales.sellerId, storeName: stores.name, open: sql<boolean>`${sales.storeId} is null` }).from(sales)
      .innerJoin(discountApprovalRequests, eq(discountApprovalRequests.saleId, sales.id)).leftJoin(stores, eq(stores.id, sales.storeId))
      .where(or(
        and(eq(sales.status, 'PENDING_DISCOUNT_APPROVAL'), lte(discountApprovalRequests.expiresAt, now)),
        and(eq(sales.status, 'DISCOUNT_APPROVED'), lt(sales.businessDate, businessDate(now))),
      ))
      .for('update', { of: sales, skipLocked: true });
    await expire(tx, rows, now, { actorId: null, branchId: await defaultBranchId(), requestId: null, ip: null }, true);
    return { expired: rows.length };
  });
}
