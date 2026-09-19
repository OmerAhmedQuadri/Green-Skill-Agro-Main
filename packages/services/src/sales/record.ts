import {
  allocateSale, assertSaleCredit, businessDate, dec, DomainError, percent, priceSale, toBaseUnits, transfer, transitionSale,
  type Money, type PricedSale, type Quantity, type SkuUnits,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, eq, sql } from 'drizzle-orm';
import { sellerVehicleAccount } from '../attendance';
import { authorize, type Ctx } from '../context';
import { batchRefs, postStockMovements } from '../inventory';
import { notify } from '../notifications';
import { audit, inTx, type Tx } from '../platform';
import { getDb } from '../runtime';
import { consumeCreditOverride, loadStore, postStoreDebit, takePayment, type PaymentMethod, type Store } from '../stores';
import { unitsOf } from '../vehicles';
import { loadSale, type Sale } from './access';
import { createDeliveryDocument } from './documents';
import { saleLimits, saleTerms, sellableBatches, type SaleLimits } from './options';

const { sales, saleLines, saleLineAllocations, discountApprovalRequests } = schema;

export type SaleView = Sale & { readonly sendingMode: SaleLimits['sendingMode'] };
export type SalePayment = { readonly method: PaymentMethod; readonly reference?: string | null | undefined };

export type RecordSaleInput = {
  readonly storeId: string;
  readonly lines: readonly { readonly skuId: string; readonly packs: number; readonly discount?: string | undefined }[];
  /** SAL-006: how a bill-to-bill store pays, at completion. */ readonly payment?: SalePayment | null | undefined;
  /** PRC-009: the reason, when a discount above the ceiling is to be requested. */ readonly approvalReason?: string | null | undefined;
};

/** One seller, one vehicle: two sales on it take their stock one after the other. */
const lockVehicle = (tx: Tx, vehicleId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`vehicle-stock:${vehicleId}`}, 0))`);

export async function viewSale(db: Parameters<typeof loadSale>[0], ctx: Ctx, id: string): Promise<SaleView> {
  const sale = await loadSale(db, ctx, id);
  return { ...sale, sendingMode: (await saleLimits(db)).sendingMode };
}

/** One sale the caller may see, with the document-sending mode (DOC-004). */
export async function getSale(ctx: Ctx, id: string): Promise<SaleView> {
  authorize(ctx, 'sales.record');
  return viewSale(ctx.tx ?? getDb(), ctx, id);
}

/**
 * STATE-MACHINES §2, → COMPLETED: the stock leaves the vehicle batch by
 * batch, the store owes the total — or pays it at once, bill to bill — an
 * override this sale needed is used up, and the delivery document is numbered
 * (SAL-006..008, ADR-0019). One transaction: it all happens or none of it.
 */
async function settle(
  tx: Tx, ctx: Ctx,
  sale: { id: string; store: Store; vehicleId: string; total: Money },
  allocations: readonly { batchId: string; quantity: Quantity }[], opts: { usesOverride: boolean; payment: SalePayment | null | undefined },
): Promise<{ ledgerEntryId: string; paymentId: string | null; creditOverrideId: string | null }> {
  if (sale.store.creditMode === 'BILL_TO_BILL' && !opts.payment) throw new DomainError('PAYMENT_REQUIRED');
  const refs = await batchRefs(tx, allocations.map((a) => a.batchId));
  const legs = allocations.flatMap((a) => {
    const batch = refs.get(a.batchId);
    if (!batch) throw new Error('allocated batch missing');
    return transfer(batch, a.quantity, { kind: 'VEHICLE', vehicleId: sale.vehicleId }, { kind: 'SOLD' });
  });
  await postStockMovements(tx, ctx, { referenceType: 'SALE', referenceId: sale.id, legs });
  const { entryId } = await postStoreDebit(tx, ctx, { storeId: sale.store.id, entryType: 'SALE', amount: sale.total, referenceType: 'SALE', referenceId: sale.id });
  const payment = sale.store.creditMode === 'BILL_TO_BILL' && opts.payment
    ? await takePayment(tx, ctx, { storeId: sale.store.id, amount: sale.total, method: opts.payment.method, reference: opts.payment.reference })
    : null;
  const creditOverrideId = opts.usesOverride ? await consumeCreditOverride(tx, ctx, sale.store.id, sale.id) : null;
  return { ledgerEntryId: entryId, paymentId: payment?.id ?? null, creditOverrideId };
}

/**
 * Workflow I (SAL-001..011, PRC-008..011). Within the ceilings the sale is
 * completed in this one request. Above them, with a reason, it becomes a
 * request for approval that holds its batches and posts nothing; without a
 * reason it is refused with the lines that need one. Guards run in the order
 * of STATE-MACHINES §2.
 */
export async function recordSale(ctx: Ctx, input: RecordSaleInput): Promise<SaleView> {
  authorize(ctx, 'sales.record');
  const lines = input.lines.map((l) => ({ skuId: l.skuId, packs: l.packs, discount: percent(l.discount?.trim() || '0') }));
  if (lines.some((l) => dec(l.discount).gt(0)) && !ctx.permissions.has('sales.apply_discount')) throw new DomainError('DISCOUNT_NOT_PERMITTED');
  const reason = input.approvalReason?.trim() || null;

  return inTx(ctx, async (tx) => {
    const account = await sellerVehicleAccount(tx, ctx);                 // 1. an open check-in, with the vehicle
    await lockVehicle(tx, account.vehicleId);
    const store = await loadStore(tx, ctx, input.storeId);               // the seller's own store
    assertSaleCredit(store.credit, store.creditMode, '0.00' as Money);   // 2, 3. active, not blocked — before anything else
    const limits = await saleLimits(tx);
    const terms = await saleTerms(tx, store.priceList.id, lines.map((l) => l.skuId));
    const priced = priceSale(lines, terms, limits);                      // 4, 6. whole packs, prices, ceilings
    if (priced.needsApproval && !reason) {
      throw new DomainError('DISCOUNT_ABOVE_CEILING', { lines: priced.lines.filter((l) => l.aboveCeiling).map((l) => ({ skuId: l.skuId, discount: l.discount, ceiling: l.ceiling })) });
    }
    const { usesOverride } = assertSaleCredit(store.credit, store.creditMode, priced.total); // OQ-018: the limit, with the total

    const batches = await sellableBatches(tx, account.vehicleId, ctx.now); // 5. sellable vehicle stock, FEFO
    const units = new Map<string, SkuUnits>(batches.map((b) => [b.skuId, unitsOf(b.size)]));
    const allocated = allocateSale(priced.lines.map((l) => {
      const u = units.get(l.skuId);
      if (!u) throw new DomainError('INSUFFICIENT_STOCK', { skuId: l.skuId, shortfall: 'all' });
      return { skuId: l.skuId, quantity: toBaseUnits(l.packs, u) };
    }), batches);

    const id = newId();
    const pending = priced.needsApproval;
    if (!pending && store.creditMode === 'BILL_TO_BILL' && !input.payment) throw new DomainError('PAYMENT_REQUIRED');
    const posted = pending ? null : await settle(tx, ctx, { id, store, vehicleId: account.vehicleId, total: priced.total },
      allocated.flatMap((a) => a.allocations), { usesOverride, payment: input.payment });

    await tx.insert(sales).values({
      id, storeId: store.id, sellerId: ctx.user.id, vehicleId: account.vehicleId, status: pending ? 'PENDING_DISCOUNT_APPROVAL' : 'COMPLETED',
      businessDate: businessDate(ctx.now), gross: priced.gross, discount: priced.discount, total: priced.total,
      ledgerEntryId: posted?.ledgerEntryId ?? null, paymentId: posted?.paymentId ?? null, creditOverrideId: posted?.creditOverrideId ?? null,
      completedAt: pending ? null : ctx.now, branchId: ctx.branchId, createdAt: ctx.now, createdBy: ctx.user.id, updatedAt: ctx.now, updatedBy: ctx.user.id,
    });
    for (const line of priced.lines) {
      const lineId = newId();
      const u = units.get(line.skuId);
      if (!u) throw new Error('units missing');
      await tx.insert(saleLines).values({
        id: lineId, saleId: id, skuId: line.skuId, packs: line.packs, quantity: toBaseUnits(line.packs, u), unitPrice: line.unitPrice,
        ceiling: line.ceiling, requestedDiscount: line.discount, discount: line.discount,
        gross: line.gross, discountAmount: line.discountAmount, total: line.total,
      });
      const own = allocated.find((a) => a.skuId === line.skuId)?.allocations ?? [];
      await tx.insert(saleLineAllocations).values(own.map((a) => ({ saleLineId: lineId, batchId: a.batchId, quantity: a.quantity, unitPrice: line.unitPrice })));
    }

    if (pending) {
      await openDiscountRequest(tx, ctx, { saleId: id, storeName: store.name, reason: reason ?? '', expiryMinutes: limits.approvalExpiryMinutes, priced });
    } else {
      const number = await createDeliveryDocument(tx, ctx, id);
      await audit(tx, ctx, {
        action: 'sales.completed', entityType: 'sale', entityId: id,
        after: { storeId: store.id, total: priced.total, discount: priced.discount, document: number, overrideUsed: usesOverride, payment: input.payment?.method ?? null },
      });
    }
    return viewSale(tx, ctx, id);
  });
}

/**
 * PRC-009..012: a sale above its ceiling becomes a request — its approvers are
 * told at once, and it expires after the configured minutes.
 */
export async function openDiscountRequest(
  tx: Tx, ctx: Ctx, input: { saleId: string; storeName: string; reason: string; expiryMinutes: number; priced: PricedSale },
): Promise<void> {
  const expiresAt = new Date(ctx.now.getTime() + input.expiryMinutes * 60_000);
  await tx.insert(discountApprovalRequests).values({
    saleId: input.saleId, reason: input.reason, requestedAt: ctx.now, requestedBy: ctx.user.id, expiresAt, branchId: ctx.branchId, createdAt: ctx.now,
  });
  const sale = await loadSale(tx, ctx, input.saleId);
  // PRC-012: every holder of the permission, at once.
  await notify(tx, ctx, { permission: 'sales.approve_discount' }, 'DISCOUNT_APPROVAL_REQUESTED',
    { store: input.storeName, seller: sale.seller.name, total: input.priced.total }, `/console/sales/${input.saleId}`);
  await audit(tx, ctx, {
    action: 'sales.discount_requested', entityType: 'sale', entityId: input.saleId,
    after: {
      storeId: sale.store.id, channel: sale.channel, total: input.priced.total, reason: input.reason, expiresAt,
      lines: input.priced.lines.map((l) => ({ skuId: l.skuId, packs: l.packs, discount: l.discount, ceiling: l.ceiling })),
    },
  });
}

export async function lockOwnSale(tx: Tx, ctx: Ctx, id: string, version: number) {
  const [row] = await tx.select().from(sales).where(eq(sales.id, id)).for('update');
  // Acted on only by its seller, or by whoever raised it for them (ADR-0038).
  if (!row || (row.sellerId !== ctx.user.id && row.createdBy !== ctx.user.id)) throw new DomainError('NOT_FOUND', { entity: 'sale', id });
  if (row.version !== version) throw new DomainError('VERSION_CONFLICT', { expected: version, actual: row.version });
  return row;
}

/**
 * PRC-014: approved, the seller completes the sale at the store at the
 * approved discounts — posting exactly the batches it held.
 */
export async function completeSale(ctx: Ctx, id: string, input: { version: number; payment?: SalePayment | null | undefined }): Promise<SaleView> {
  authorize(ctx, 'sales.record');
  return inTx(ctx, async (tx) => {
    const account = await sellerVehicleAccount(tx, ctx);
    await lockVehicle(tx, account.vehicleId);
    const row = await lockOwnSale(tx, ctx, id, input.version);
    // A dispatch sale goes to the warehouse instead (ADR-0038), never completes here.
    if (row.channel !== 'VEHICLE' || !row.vehicleId) throw new DomainError('INVALID_TRANSITION', { from: row.status, action: 'complete' });
    const status = transitionSale(row.status, 'complete');
    if (row.vehicleId !== account.vehicleId) throw new DomainError('VEHICLE_NOT_ASSIGNED', { vehicleId: row.vehicleId });
    const vehicleId = row.vehicleId;
    const store = await loadStore(tx, ctx, row.storeId);
    const { usesOverride } = assertSaleCredit(store.credit, store.creditMode, row.total as Money);
    const allocations = await tx.select({ batchId: saleLineAllocations.batchId, quantity: saleLineAllocations.quantity })
      .from(saleLineAllocations).innerJoin(saleLines, eq(saleLines.id, saleLineAllocations.saleLineId)).where(eq(saleLines.saleId, id));
    const posted = await settle(tx, ctx, { id, store, vehicleId, total: row.total as Money },
      allocations.map((a) => ({ batchId: a.batchId, quantity: a.quantity as Quantity })), { usesOverride, payment: input.payment });
    await tx.update(sales).set({
      status, ...posted, completedAt: ctx.now, updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1,
    }).where(and(eq(sales.id, id), eq(sales.version, row.version)));
    const number = await createDeliveryDocument(tx, ctx, id);
    await audit(tx, ctx, { action: 'sales.completed', entityType: 'sale', entityId: id, after: { total: row.total, discount: row.discount, document: number, overrideUsed: usesOverride } });
    return viewSale(tx, ctx, id);
  });
}

/**
 * PRC-015: the seller may withdraw at any time — the owner walked away —
 * which cancels the sale and frees what it held.
 */
export async function withdrawSale(ctx: Ctx, id: string, input: { version: number }): Promise<SaleView> {
  authorize(ctx, 'sales.record');
  return inTx(ctx, async (tx) => {
    const row = await lockOwnSale(tx, ctx, id, input.version);
    transitionSale(row.status, 'withdraw');
    await tx.update(sales).set({
      status: 'CANCELLED', cancelReason: 'WITHDRAWN', cancelledAt: ctx.now, updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1,
    }).where(eq(sales.id, id));
    await tx.update(discountApprovalRequests).set({ status: sql`case when ${discountApprovalRequests.status} = 'PENDING' then 'WITHDRAWN'::discount_request_status else ${discountApprovalRequests.status} end`, closedAt: ctx.now })
      .where(eq(discountApprovalRequests.saleId, id));
    await audit(tx, ctx, { action: 'sales.withdrawn', entityType: 'sale', entityId: id, before: { status: row.status } });
    return viewSale(tx, ctx, id);
  });
}
