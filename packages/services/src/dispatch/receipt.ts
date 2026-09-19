import {
  checkReceipt, dec, Dec, DomainError, lineAmounts, packCount, sumMoney, toBaseUnits, transfer, transitionDispatch, transitionSale,
  type ConfirmationMode, type Leg, type Money, type Percent, type Quantity, type ShortfallResolution,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, sql } from 'drizzle-orm';
import { assertSellerWorking } from '../attendance';
import { authorize, type Ctx } from '../context';
import { batchRefs, postStockMovements } from '../inventory';
import { audit, inTx } from '../platform';
import { createDeliveryDocument, type SalePayment } from '../sales';
import { loadStore, postStoreDebit, readingAsManager, takePayment } from '../stores';
import { loadOrder, type DispatchOrder } from './access';
import { lockOrder } from './handle';
import { skuUnits } from './stock';

const { dispatchOrders, dispatchOrderLines, dispatchLineBatches, dispatchOrderEvents, lostOrderClaims, sales, saleLines, saleLineAllocations, batches } = schema;

export type ReceiptInput = {
  readonly version: number; readonly mode: ConfirmationMode;
  readonly lines: readonly { readonly lineId: string; readonly received: number; readonly short: number; readonly damaged: number }[];
  /** SAL-006: a bill-to-bill store pays for what arrived, now. */ readonly payment?: SalePayment | null | undefined;
};

/**
 * DSP-009..012, OQ-019: the seller of record confirms what arrived, line by
 * line, and how — in person, or on the owner's word (kept for the next
 * vehicle audit). The packs received become the sale: they leave the
 * dispatched position as sold, the store owes for them, the delivery document
 * is numbered. Short and damaged packs are written off as lost in transit;
 * with any, the order waits for the seller to say how the gap is made good.
 */
export async function confirmReceipt(ctx: Ctx, id: string, input: ReceiptInput): Promise<DispatchOrder> {
  authorize(ctx, 'sales.confirm_dispatch_receipt');
  return inTx(ctx, async (tx) => {
    const row = await lockOrder(tx, id, input.version);
    if (row.sellerId !== ctx.user.id) throw new DomainError('NOT_FOUND', { entity: 'dispatch_order', id });
    await assertSellerWorking(tx, ctx);
    const [claim] = await tx.select({ id: lostOrderClaims.id }).from(lostOrderClaims).where(and(eq(lostOrderClaims.orderId, id), eq(lostOrderClaims.status, 'PENDING')));
    if (claim) throw new DomainError('CLAIM_PENDING', { claimId: claim.id });
    const status = transitionDispatch(row.status, 'confirm');

    const lines = await tx.select({ ol: dispatchOrderLines, sl: saleLines }).from(dispatchOrderLines)
      .innerJoin(saleLines, eq(saleLines.id, dispatchOrderLines.saleLineId)).where(eq(dispatchOrderLines.orderId, id));
    const given = new Map(input.lines.map((l) => [l.lineId, l]));
    for (const l of input.lines) if (!lines.some((x) => x.ol.id === l.lineId)) throw new DomainError('NOT_FOUND', { entity: 'dispatch_order_line', id: l.lineId });
    const receipt = lines.map((l) => {
      const g = given.get(l.ol.id);
      return { lineId: l.ol.id, released: l.ol.packs, received: g?.received ?? -1, short: g?.short ?? 0, damaged: g?.damaged ?? 0 };
    });
    const { shortfall } = checkReceipt(receipt);

    const [sale] = await tx.select().from(sales).where(eq(sales.id, row.saleId)).for('update');
    if (!sale) throw new Error('sale missing for its order');
    const saleStatus = transitionSale(sale.status, 'deliver');
    // The store as it stands now — its seller may have changed since the order was raised.
    const store = await loadStore(tx, readingAsManager(ctx), row.storeId);
    if (store.creditMode === 'BILL_TO_BILL' && !input.payment) throw new DomainError('PAYMENT_REQUIRED');

    const released = await tx.select({ b: dispatchLineBatches, expiresOn: batches.expiresOn }).from(dispatchLineBatches)
      .innerJoin(batches, eq(batches.id, dispatchLineBatches.batchId)).innerJoin(dispatchOrderLines, eq(dispatchOrderLines.id, dispatchLineBatches.orderLineId))
      .where(eq(dispatchOrderLines.orderId, id)).orderBy(sql`${batches.expiresOn} asc nulls last`);
    const units = await skuUnits(tx, lines.map((l) => l.sl.skuId));
    const refs = await batchRefs(tx, released.map((r) => r.b.batchId));
    const sold: Leg[] = [];
    const lost: Leg[] = [];
    const totals: Money[] = [];
    const discounts: Money[] = [];
    const grosses: Money[] = [];
    for (const l of lines) {
      const r = receipt.find((x) => x.lineId === l.ol.id);
      const u = units.get(l.sl.skuId);
      if (!r || !u) throw new Error('receipt line missing');
      // Received packs are taken from the line's batches soonest expiry first; the rest is what went missing.
      let toSell = dec(toBaseUnits(packCount(r.received), u));
      for (const b of released.filter((x) => x.b.orderLineId === l.ol.id)) {
        const ref = refs.get(b.b.batchId);
        if (!ref) throw new Error('batch missing');
        const q = dec(b.b.quantity);
        const take = Dec.min(q, toSell);
        if (take.gt(0)) {
          sold.push(...transfer(ref, take.toFixed(3) as Quantity, { kind: 'DISPATCHED' }, { kind: 'SOLD' }));
          await tx.insert(saleLineAllocations).values({ saleLineId: l.sl.id, batchId: b.b.batchId, quantity: take.toFixed(3), unitPrice: l.sl.unitPrice });
        }
        if (q.minus(take).gt(0)) lost.push(...transfer(ref, q.minus(take).toFixed(3) as Quantity, { kind: 'DISPATCHED' }, { kind: 'WRITTEN_OFF' }));
        toSell = toSell.minus(take);
      }
      const amounts = lineAmounts(l.sl.unitPrice as Money, r.received, l.sl.discount as Percent);
      totals.push(amounts.total); discounts.push(amounts.discountAmount); grosses.push(amounts.gross);
      await tx.update(saleLines).set({ packs: r.received, quantity: toBaseUnits(packCount(r.received), u), gross: amounts.gross, discountAmount: amounts.discountAmount, total: amounts.total })
        .where(eq(saleLines.id, l.sl.id));
      await tx.update(dispatchOrderLines).set({ receivedPacks: r.received, shortPacks: r.short, damagedPacks: r.damaged }).where(eq(dispatchOrderLines.id, l.ol.id));
    }
    await postStockMovements(tx, ctx, { referenceType: 'SALE', referenceId: sale.id, legs: sold });
    if (lost.length > 0) await postStockMovements(tx, ctx, { referenceType: 'DISPATCH_ORDER', referenceId: id, legs: lost });

    const total = sumMoney(totals);
    const { entryId } = await postStoreDebit(tx, ctx, { storeId: row.storeId, entryType: 'SALE', amount: total, referenceType: 'SALE', referenceId: sale.id });
    const payment = store.creditMode === 'BILL_TO_BILL' && input.payment
      ? await takePayment(tx, ctx, { storeId: row.storeId, amount: total, method: input.payment.method, reference: input.payment.reference })
      : null;
    await tx.update(sales).set({
      status: saleStatus, gross: sumMoney(grosses), discount: sumMoney(discounts), total, ledgerEntryId: entryId, paymentId: payment?.id ?? null,
      completedAt: ctx.now, updatedAt: ctx.now, updatedBy: ctx.user.id, version: sale.version + 1,
    }).where(eq(sales.id, sale.id));
    const number = await createDeliveryDocument(tx, ctx, sale.id);

    const done = shortfall === 0;
    await tx.update(dispatchOrders).set({
      status: done ? transitionDispatch(status, 'resolve') : status, confirmedAt: ctx.now, confirmedBy: ctx.user.id, confirmationMode: input.mode,
      ...(done ? { closedAt: ctx.now, closeReason: 'DELIVERED' as const } : {}), updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1,
    }).where(eq(dispatchOrders.id, id));
    await tx.insert(dispatchOrderEvents).values({ orderId: id, type: 'CONFIRMED', actorId: ctx.user.id, note: input.mode, occurredAt: ctx.now });
    await audit(tx, ctx, {
      action: 'dispatch.received', entityType: 'dispatch_order', entityId: id,
      after: { mode: input.mode, lines: receipt, total, document: number, payment: input.payment?.method ?? null },
    });
    return loadOrder(tx, ctx, id);
  });
}

/**
 * DSP-011, DSP-012, OQ-019: how the gap is made good — from the seller's
 * vehicle, by a further order, or not at all. The app then opens that sale or
 * order, pre-filled; the order is closed.
 */
export async function resolveShortfall(ctx: Ctx, id: string, input: { version: number; resolution: ShortfallResolution }): Promise<DispatchOrder> {
  authorize(ctx, 'sales.confirm_dispatch_receipt');
  return inTx(ctx, async (tx) => {
    const row = await lockOrder(tx, id, input.version);
    if (row.sellerId !== ctx.user.id) throw new DomainError('NOT_FOUND', { entity: 'dispatch_order', id });
    const status = transitionDispatch(row.status, 'resolve');
    await tx.update(dispatchOrders).set({
      status, resolution: input.resolution, closedAt: ctx.now, closeReason: 'DELIVERED', updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1,
    }).where(eq(dispatchOrders.id, id));
    await tx.insert(dispatchOrderEvents).values({ orderId: id, type: 'RESOLVED', actorId: ctx.user.id, note: input.resolution, occurredAt: ctx.now });
    await audit(tx, ctx, { action: 'dispatch.shortfall_resolved', entityType: 'dispatch_order', entityId: id, after: { resolution: input.resolution } });
    return loadOrder(tx, ctx, id);
  });
}
