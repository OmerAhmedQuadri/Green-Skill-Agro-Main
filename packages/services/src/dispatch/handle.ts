import { allocateSale, DomainError, toBaseUnits, transfer, transitionDispatch, transitionSale, packCount } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import { batchRefs, postStockMovements, warehouseAccount } from '../inventory';
import { assertOwnEvidence } from '../media';
import { notify } from '../notifications';
import { audit, inTx, type Tx } from '../platform';
import { loadOrder, type DispatchOrder } from './access';
import { skuUnits, warehouseBatches } from './stock';

const { dispatchOrders, dispatchOrderLines, dispatchLineBatches, dispatchOrderEvents, saleLines, sales, users } = schema;

export async function lockOrder(tx: Tx, id: string, version: number) {
  const [row] = await tx.select().from(dispatchOrders).where(eq(dispatchOrders.id, id)).for('update');
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'dispatch_order', id });
  if (row.version !== version) throw new DomainError('VERSION_CONFLICT', { expected: version, actual: row.version });
  return row;
}

/**
 * DSP-004, DSP-005: a manager takes the order — their name shows against it.
 * A label, not a lock: another manager may take it over, and every step is
 * in the order's history.
 */
export async function takeOrder(ctx: Ctx, id: string, input: { version: number }): Promise<DispatchOrder> {
  authorize(ctx, 'sales.fulfil_dispatch');
  return inTx(ctx, async (tx) => {
    const row = await lockOrder(tx, id, input.version);
    const status = transitionDispatch(row.status, 'take');
    const [previous] = row.handledBy && row.handledBy !== ctx.user.id ? await tx.select({ name: users.name }).from(users).where(eq(users.id, row.handledBy)) : [];
    await tx.update(dispatchOrders).set({ status, handledBy: ctx.user.id, handledAt: ctx.now, updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1 })
      .where(eq(dispatchOrders.id, id));
    await tx.insert(dispatchOrderEvents).values({ orderId: id, type: 'TAKEN', actorId: ctx.user.id, note: previous?.name ?? null, occurredAt: ctx.now });
    return loadOrder(tx, ctx, id);
  });
}

/** DSP-005: handed back, so another manager can take it. */
export async function releaseOrderBack(ctx: Ctx, id: string, input: { version: number }): Promise<DispatchOrder> {
  authorize(ctx, 'sales.fulfil_dispatch');
  return inTx(ctx, async (tx) => {
    const row = await lockOrder(tx, id, input.version);
    const status = transitionDispatch(row.status, 'release_back');
    await tx.update(dispatchOrders).set({ status, handledBy: null, handledAt: null, updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1 })
      .where(eq(dispatchOrders.id, id));
    await tx.insert(dispatchOrderEvents).values({ orderId: id, type: 'RELEASED_BACK', actorId: ctx.user.id, occurredAt: ctx.now });
    return loadOrder(tx, ctx, id);
  });
}

/**
 * DSP-006..008, OQ-019: transport booked, the slip photographed; the stock is
 * taken from the warehouse now, soonest expiry first, into the dispatched
 * position — never a vehicle. Not enough in the warehouse: it waits.
 */
export async function releaseOrder(
  ctx: Ctx, id: string, input: { version: number; transportSlipPhotoId: string; transportNote?: string | null | undefined },
): Promise<DispatchOrder> {
  authorize(ctx, 'sales.fulfil_dispatch');
  return inTx(ctx, async (tx) => {
    const row = await lockOrder(tx, id, input.version);
    const status = transitionDispatch(row.status, 'release');
    await assertOwnEvidence(tx, ctx, input.transportSlipPhotoId, 'TRANSPORT_SLIP');
    const lines = await tx.select({ id: dispatchOrderLines.id, packs: dispatchOrderLines.packs, skuId: saleLines.skuId })
      .from(dispatchOrderLines).innerJoin(saleLines, eq(saleLines.id, dispatchOrderLines.saleLineId)).where(eq(dispatchOrderLines.orderId, id));
    const units = await skuUnits(tx, lines.map((l) => l.skuId));
    const allocated = allocateSale(lines.map((l) => {
      const u = units.get(l.skuId);
      if (!u) throw new Error('sku units missing');
      return { skuId: l.skuId, quantity: toBaseUnits(packCount(l.packs), u) };
    }), await warehouseBatches(tx, lines.map((l) => l.skuId), ctx.now));
    const account = await warehouseAccount(tx);
    const refs = await batchRefs(tx, allocated.flatMap((a) => a.allocations.map((x) => x.batchId)));
    const legs = [];
    for (const line of lines) {
      for (const a of allocated.find((x) => x.skuId === line.skuId)?.allocations ?? []) {
        const ref = refs.get(a.batchId);
        if (!ref) throw new Error('batch missing');
        legs.push(...transfer(ref, a.quantity, account, { kind: 'DISPATCHED' }));
        await tx.insert(dispatchLineBatches).values({ orderLineId: line.id, batchId: a.batchId, quantity: a.quantity });
      }
    }
    await postStockMovements(tx, ctx, { referenceType: 'DISPATCH_ORDER', referenceId: id, legs });
    const note = input.transportNote?.trim() || null;
    await tx.update(dispatchOrders).set({
      status, releasedAt: ctx.now, releasedBy: ctx.user.id, transportSlipMediaId: input.transportSlipPhotoId, transportNote: note,
      handledBy: row.handledBy ?? ctx.user.id, handledAt: row.handledAt ?? ctx.now, updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1,
    }).where(eq(dispatchOrders.id, id));
    await tx.insert(dispatchOrderEvents).values({ orderId: id, type: 'RELEASED', actorId: ctx.user.id, note, occurredAt: ctx.now });
    const order = await loadOrder(tx, ctx, id);
    await notify(tx, ctx, { users: [row.sellerId] }, 'DISPATCH_RELEASED', { number: row.number, store: order.store.name }, `/field/orders/${id}`);
    await audit(tx, ctx, { action: 'dispatch.released', entityType: 'dispatch_order', entityId: id, after: { batches: allocated, transportSlipPhotoId: input.transportSlipPhotoId } });
    return order;
  });
}

/**
 * STATE-MACHINES §3: cancelled with a reason, only before release — once the
 * goods have left, the paths are receipt or a lost-order claim. Whoever
 * raised it, its seller, or those who fulfil dispatch.
 */
export async function cancelOrder(ctx: Ctx, id: string, input: { version: number; reason: string }): Promise<DispatchOrder> {
  authorizeAny(ctx, ['sales.request_dispatch', 'sales.create_order_for_seller', 'sales.fulfil_dispatch']);
  const reason = input.reason.trim();
  if (!reason) throw new DomainError('REASON_REQUIRED', { action: 'cancel' });
  return inTx(ctx, async (tx) => {
    const row = await lockOrder(tx, id, input.version);
    const involved = row.raisedBy === ctx.user.id || row.sellerId === ctx.user.id || ctx.permissions.has('sales.fulfil_dispatch');
    if (!involved) throw new DomainError('NOT_FOUND', { entity: 'dispatch_order', id });
    const status = transitionDispatch(row.status, 'cancel');
    const [sale] = await tx.select().from(sales).where(eq(sales.id, row.saleId)).for('update');
    if (!sale) throw new Error('sale missing for its order');
    transitionSale(sale.status, 'cancel');
    await tx.update(sales).set({ status: 'CANCELLED', cancelReason: 'REQUEST_CANCELLED', cancelledAt: ctx.now, updatedAt: ctx.now, updatedBy: ctx.user.id, version: sale.version + 1 })
      .where(eq(sales.id, sale.id));
    await tx.update(dispatchOrders).set({
      status, closeReason: 'CANCELLED', closedAt: ctx.now, cancelReason: reason, updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1,
    }).where(eq(dispatchOrders.id, id));
    await tx.insert(dispatchOrderEvents).values({ orderId: id, type: 'CANCELLED', actorId: ctx.user.id, note: reason, occurredAt: ctx.now });
    const order = await loadOrder(tx, ctx, id);
    await notify(tx, ctx, { users: [row.sellerId, row.raisedBy] }, 'DISPATCH_CANCELLED', { number: row.number, store: order.store.name, reason }, `/field/orders/${id}`);
    await audit(tx, ctx, { action: 'dispatch.cancelled', entityType: 'dispatch_order', entityId: id, after: { reason } });
    return order;
  });
}
