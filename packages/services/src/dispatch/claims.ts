import { DomainError, transfer, transitionDispatch, transitionSale, type Leg, type Quantity } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { batchRefs, postStockMovements } from '../inventory';
import { notify } from '../notifications';
import { audit, inTx } from '../platform';
import { loadOrder, type DispatchOrder } from './access';
import { lockOrder } from './handle';

const { dispatchOrders, dispatchOrderLines, dispatchLineBatches, dispatchOrderEvents, lostOrderClaims, sales } = schema;

/** DSP-013: nothing arrived — the seller of record says why; approvers are told. */
export async function raiseLostClaim(ctx: Ctx, id: string, input: { version: number; reason: string }): Promise<DispatchOrder> {
  authorize(ctx, 'sales.confirm_dispatch_receipt');
  const reason = input.reason.trim();
  if (!reason) throw new DomainError('REASON_REQUIRED', { action: 'lost_claim' });
  return inTx(ctx, async (tx) => {
    const row = await lockOrder(tx, id, input.version);
    if (row.sellerId !== ctx.user.id) throw new DomainError('NOT_FOUND', { entity: 'dispatch_order', id });
    if (row.status !== 'RELEASED') throw new DomainError('INVALID_TRANSITION', { from: row.status, action: 'lost_claim' });
    const [pending] = await tx.select({ id: lostOrderClaims.id }).from(lostOrderClaims).where(and(eq(lostOrderClaims.orderId, id), eq(lostOrderClaims.status, 'PENDING')));
    if (pending) throw new DomainError('CLAIM_PENDING', { claimId: pending.id });
    await tx.insert(lostOrderClaims).values({ orderId: id, reason, raisedBy: ctx.user.id, raisedAt: ctx.now, branchId: ctx.branchId, createdAt: ctx.now });
    await tx.update(dispatchOrders).set({ updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1 }).where(eq(dispatchOrders.id, id));
    await tx.insert(dispatchOrderEvents).values({ orderId: id, type: 'CLAIMED', actorId: ctx.user.id, note: reason, occurredAt: ctx.now });
    const order = await loadOrder(tx, ctx, id);
    await notify(tx, ctx, { permission: 'sales.approve_lost_order' }, 'LOST_CLAIM_RAISED', { number: row.number, store: order.store.name }, `/console/dispatch/${id}`);
    await audit(tx, ctx, { action: 'dispatch.lost_claimed', entityType: 'dispatch_order', entityId: id, after: { reason } });
    return order;
  });
}

/**
 * DSP-013: approved, the dispatched stock is written off, the pending sale
 * cancelled and the order closed; rejected, with a comment, the order stays
 * released for receipt. Four-eyes: never the claimant.
 */
export async function decideLostClaim(ctx: Ctx, id: string, input: { version: number; approve: boolean; comment?: string | null | undefined }): Promise<DispatchOrder> {
  authorize(ctx, 'sales.approve_lost_order');
  const comment = input.comment?.trim() || null;
  if (!input.approve && !comment) throw new DomainError('REASON_REQUIRED', { action: 'reject' });
  return inTx(ctx, async (tx) => {
    const row = await lockOrder(tx, id, input.version);
    const [claim] = await tx.select().from(lostOrderClaims).where(and(eq(lostOrderClaims.orderId, id), eq(lostOrderClaims.status, 'PENDING'))).for('update');
    if (!claim) throw new DomainError('ALREADY_DECIDED', { entity: 'lost_order_claim' });
    if (claim.raisedBy === ctx.user.id || row.sellerId === ctx.user.id) throw new DomainError('FOUR_EYES');
    await tx.update(lostOrderClaims).set({ status: input.approve ? 'APPROVED' : 'REJECTED', decidedBy: ctx.user.id, decidedAt: ctx.now, comment })
      .where(eq(lostOrderClaims.id, claim.id));
    if (input.approve) {
      const status = transitionDispatch(row.status, 'lose');
      const released = await tx.select({ batchId: dispatchLineBatches.batchId, quantity: dispatchLineBatches.quantity }).from(dispatchLineBatches)
        .innerJoin(dispatchOrderLines, eq(dispatchOrderLines.id, dispatchLineBatches.orderLineId)).where(eq(dispatchOrderLines.orderId, id));
      const refs = await batchRefs(tx, released.map((r) => r.batchId));
      const legs: Leg[] = released.flatMap((r) => {
        const ref = refs.get(r.batchId);
        if (!ref) throw new Error('batch missing');
        return transfer(ref, r.quantity as Quantity, { kind: 'DISPATCHED' }, { kind: 'WRITTEN_OFF' });
      });
      await postStockMovements(tx, ctx, { referenceType: 'LOST_ORDER_CLAIM', referenceId: claim.id, legs });
      const [sale] = await tx.select().from(sales).where(eq(sales.id, row.saleId)).for('update');
      if (!sale) throw new Error('sale missing for its order');
      transitionSale(sale.status, 'lose');
      await tx.update(sales).set({ status: 'CANCELLED', cancelReason: 'LOST', cancelledAt: ctx.now, updatedAt: ctx.now, updatedBy: ctx.user.id, version: sale.version + 1 })
        .where(eq(sales.id, sale.id));
      await tx.update(dispatchOrders).set({ status, closedAt: ctx.now, closeReason: 'LOST', updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1 })
        .where(eq(dispatchOrders.id, id));
    } else {
      await tx.update(dispatchOrders).set({ updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1 }).where(eq(dispatchOrders.id, id));
    }
    await tx.insert(dispatchOrderEvents).values({ orderId: id, type: input.approve ? 'CLAIM_APPROVED' : 'CLAIM_REJECTED', actorId: ctx.user.id, note: comment, occurredAt: ctx.now });
    const order = await loadOrder(tx, ctx, id);
    await notify(tx, ctx, { users: [row.sellerId] }, 'LOST_CLAIM_DECIDED', { number: row.number, store: order.store.name, outcome: input.approve ? 'APPROVED' : 'REJECTED' }, `/field/orders/${id}`);
    await audit(tx, ctx, { action: 'dispatch.lost_claim_decided', entityType: 'dispatch_order', entityId: id, after: { approved: input.approve, comment } });
    return order;
  });
}
