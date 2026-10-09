import {
  allocateSale, assertLocation, assertPaidInFull, assertSaleCredit, businessDate, dec, DomainError, money, normaliseContactNumber, openSaleGrounds,
  percent, priceSale, toBaseUnits, transfer, transitionSale, type Money, type OpenSaleGround, type PricedSale, type Quantity, type SkuUnits,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, eq, sql } from 'drizzle-orm';
import { sellerVehicleAccount } from '../attendance';
import { authorize, type Ctx } from '../context';
import { batchRefs, postStockMovements } from '../inventory';
import { endRequest, notify } from '../notifications';
import { audit, inTx, type Tx } from '../platform';
import { getDb } from '../runtime';
import { consumeCreditOverride, loadStore, postStoreDebit, takePayment, type PaymentInput } from '../stores';
import { readSettings } from '../system';
import { unitsOf } from '../vehicles';
import { loadSale, type Sale } from './access';
import { createDeliveryDocument } from './documents';
import { basePriceListId, saleLimits, saleTerms, sellableBatches, type SaleLimits } from './options';

const { sales, saleLines, saleLineAllocations, discountApprovalRequests } = schema;

export type SaleView = Sale & { readonly sendingMode: SaleLimits['sendingMode'] };
/** ADR-0047: money taken with a sale or a delivery — part or all of what the store owes, with its voucher. */
export type SalePayment = Omit<PaymentInput, 'amount'> & { readonly amount: string };

export type RecordSaleInput = {
  readonly storeId: string;
  readonly lines: readonly { readonly skuId: string; readonly packs: number; readonly discount?: string | undefined }[];
  /** ADR-0047: money taken with the sale, if any — this sale's or older bills'. */ readonly payment?: SalePayment | null | undefined;
  /** PRC-009: the reason, when a discount above the ceiling is to be requested. */ readonly approvalReason?: string | null | undefined;
};

/** ADR-0052 (SAL-012..016): an open sale — no store; the buyer, if they say who they are; where it is made. */
export type RecordOpenSaleInput = {
  readonly lines: RecordSaleInput['lines'];
  readonly buyer?: { readonly name?: string | null | undefined; readonly phone?: string | null | undefined } | null | undefined;
  readonly location: { readonly lat: number; readonly lng: number; readonly accuracyM?: number | null | undefined };
  /** SAL-013: the whole total, now — unless it waits for approval, when it is paid on completion. */ readonly payment?: SalePayment | null | undefined;
  /** SAL-016: why, when it must wait for approval. */ readonly approvalReason?: string | null | undefined;
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
 * batch, the store owes the total, any money taken with it is recorded with
 * its voucher (ADR-0047), an override this sale needed is used up, and the
 * delivery document is numbered (SAL-006..008, ADR-0019). One transaction:
 * it all happens or none of it.
 */
async function settle(
  tx: Tx, ctx: Ctx,
  sale: { id: string; storeId: string | null; vehicleId: string; total: Money },
  allocations: readonly { batchId: string; quantity: Quantity }[], opts: { usesOverride: boolean; payment: SalePayment | null | undefined },
): Promise<{ ledgerEntryId: string | null; paymentId: string | null; creditOverrideId: string | null }> {
  const refs = await batchRefs(tx, allocations.map((a) => a.batchId));
  const legs = allocations.flatMap((a) => {
    const batch = refs.get(a.batchId);
    if (!batch) throw new Error('allocated batch missing');
    return transfer(batch, a.quantity, { kind: 'VEHICLE', vehicleId: sale.vehicleId }, { kind: 'SOLD' });
  });
  await postStockMovements(tx, ctx, { referenceType: 'SALE', referenceId: sale.id, legs });
  // ADR-0052: an open sale owes nobody — it is paid in full — so nothing goes on any store's ledger.
  const entryId = sale.storeId
    ? (await postStoreDebit(tx, ctx, { storeId: sale.storeId, entryType: 'SALE', amount: sale.total, referenceType: 'SALE', referenceId: sale.id })).entryId
    : null;
  // After the debit, so the money may settle this sale as well as older ones (CRD-003).
  const payment = opts.payment ? await takePayment(tx, ctx, { ...opts.payment, storeId: sale.storeId, amount: money(opts.payment.amount) }) : null;
  const creditOverrideId = opts.usesOverride && sale.storeId ? await consumeCreditOverride(tx, ctx, sale.storeId, sale.id) : null;
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
    const pending = priced.needsApproval;
    // ADR-0047: a sale waiting for approval takes its money when it completes, and meets the limit then.
    if (pending && input.payment) throw new DomainError('INVALID_TRANSITION', { from: 'PENDING_DISCOUNT_APPROVAL', action: 'pay' });
    const { usesOverride } = pending ? { usesOverride: false } // OQ-018: the limit, with the total and what is paid now
      : assertSaleCredit(store.credit, store.creditMode, priced.total, { paidNow: input.payment ? money(input.payment.amount) : undefined });

    const batches = await sellableBatches(tx, account.vehicleId, ctx.now); // 5. sellable vehicle stock, FEFO
    const units = new Map<string, SkuUnits>(batches.map((b) => [b.skuId, unitsOf(b.size)]));
    const allocated = allocateSale(priced.lines.map((l) => {
      const u = units.get(l.skuId);
      if (!u) throw new DomainError('INSUFFICIENT_STOCK', { skuId: l.skuId, shortfall: 'all' });
      return { skuId: l.skuId, quantity: toBaseUnits(l.packs, u) };
    }), batches);

    const id = newId();
    const posted = pending ? null : await settle(tx, ctx, { id, storeId: store.id, vehicleId: account.vehicleId, total: priced.total },
      allocated.flatMap((a) => a.allocations), { usesOverride, payment: input.payment });

    await tx.insert(sales).values({
      id, storeId: store.id, sellerId: ctx.user.id, vehicleId: account.vehicleId, status: pending ? 'PENDING_DISCOUNT_APPROVAL' : 'COMPLETED',
      businessDate: businessDate(ctx.now), gross: priced.gross, discount: priced.discount, total: priced.total,
      ledgerEntryId: posted?.ledgerEntryId ?? null, paymentId: posted?.paymentId ?? null, creditOverrideId: posted?.creditOverrideId ?? null,
      completedAt: pending ? null : ctx.now, branchId: ctx.branchId, createdAt: ctx.now, createdBy: ctx.user.id, updatedAt: ctx.now, updatedBy: ctx.user.id,
    });
    await insertLines(tx, id, priced, units, allocated);

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

/** One line per SKU, and the batches each was allocated or holds (SAL-008). */
async function insertLines(
  tx: Tx, saleId: string, priced: PricedSale, units: ReadonlyMap<string, SkuUnits>,
  allocated: readonly { skuId: string; allocations: readonly { batchId: string; quantity: Quantity }[] }[],
): Promise<void> {
  for (const line of priced.lines) {
    const lineId = newId();
    const u = units.get(line.skuId);
    if (!u) throw new Error('units missing');
    await tx.insert(saleLines).values({
      id: lineId, saleId, skuId: line.skuId, packs: line.packs, quantity: toBaseUnits(line.packs, u), unitPrice: line.unitPrice,
      ceiling: line.ceiling, requestedDiscount: line.discount, discount: line.discount,
      gross: line.gross, discountAmount: line.discountAmount, total: line.total,
    });
    const own = allocated.find((a) => a.skuId === line.skuId)?.allocations ?? [];
    await tx.insert(saleLineAllocations).values(own.map((a) => ({ saleLineId: lineId, batchId: a.batchId, quantity: a.quantity, unitPrice: line.unitPrice })));
  }
}

/**
 * ADR-0052 (SAL-012..017): an open sale — to a buyer who is not a store. From
 * the seller's vehicle at the base list's prices, discounts within the
 * ceilings only, paid in full there and then, with a simplified delivery
 * record. Switched off, or above the Admin's limit, it waits for approval as
 * a discount request does: the reason given, the stock held, nothing posted.
 */
export async function recordOpenSale(ctx: Ctx, input: RecordOpenSaleInput): Promise<SaleView> {
  authorize(ctx, 'sales.record');
  const lines = input.lines.map((l) => ({ skuId: l.skuId, packs: l.packs, discount: percent(l.discount?.trim() || '0') }));
  if (lines.some((l) => dec(l.discount).gt(0)) && !ctx.permissions.has('sales.apply_discount')) throw new DomainError('DISCOUNT_NOT_PERMITTED');
  const where = assertLocation(input.location);
  const accuracyM = input.location.accuracyM === null || input.location.accuracyM === undefined ? null : Math.round(input.location.accuracyM);
  const buyer = { name: input.buyer?.name?.trim() || null, phone: input.buyer?.phone?.trim() ? normaliseContactNumber(input.buyer.phone) : null };
  const reason = input.approvalReason?.trim() || null;

  return inTx(ctx, async (tx) => {
    const account = await sellerVehicleAccount(tx, ctx);                 // an open check-in, with the vehicle
    await lockVehicle(tx, account.vehicleId);
    const [limits, settings] = [await saleLimits(tx), await readSettings(tx)];
    const terms = await saleTerms(tx, await basePriceListId(tx), lines.map((l) => l.skuId));
    const priced = priceSale(lines, terms, limits);
    // SAL-014: within the ceilings — an open sale never asks for more.
    if (priced.needsApproval) {
      throw new DomainError('DISCOUNT_ABOVE_CEILING', { lines: priced.lines.filter((l) => l.aboveCeiling).map((l) => ({ skuId: l.skuId, discount: l.discount, ceiling: l.ceiling })), open: true });
    }
    const grounds = openSaleGrounds(priced.total, { switchedOn: settings['sales.open_sales_on'], limit: money(settings['sales.open_sale_limit']) });
    const pending = grounds.length > 0;
    if (pending && !reason) throw new DomainError('OPEN_SALE_NEEDS_APPROVAL', { grounds, total: priced.total });
    // As a discount request: what waits is paid when it completes.
    if (pending && input.payment) throw new DomainError('INVALID_TRANSITION', { from: 'PENDING_DISCOUNT_APPROVAL', action: 'pay' });
    if (!pending) assertPaidInFull(priced.total, input.payment ? money(input.payment.amount) : null);

    const batches = await sellableBatches(tx, account.vehicleId, ctx.now);
    const units = new Map<string, SkuUnits>(batches.map((b) => [b.skuId, unitsOf(b.size)]));
    const allocated = allocateSale(priced.lines.map((l) => {
      const u = units.get(l.skuId);
      if (!u) throw new DomainError('INSUFFICIENT_STOCK', { skuId: l.skuId, shortfall: 'all' });
      return { skuId: l.skuId, quantity: toBaseUnits(l.packs, u) };
    }), batches);

    const id = newId();
    const posted = pending ? null : await settle(tx, ctx, { id, storeId: null, vehicleId: account.vehicleId, total: priced.total },
      allocated.flatMap((a) => a.allocations), { usesOverride: false, payment: input.payment });
    await tx.insert(sales).values({
      id, storeId: null, sellerId: ctx.user.id, vehicleId: account.vehicleId, status: pending ? 'PENDING_DISCOUNT_APPROVAL' : 'COMPLETED',
      businessDate: businessDate(ctx.now), gross: priced.gross, discount: priced.discount, total: priced.total,
      ledgerEntryId: null, paymentId: posted?.paymentId ?? null, completedAt: pending ? null : ctx.now,
      buyerName: buyer.name, buyerPhone: buyer.phone, latitude: where.lat.toFixed(6), longitude: where.lng.toFixed(6), locationAccuracyM: accuracyM,
      branchId: ctx.branchId, createdAt: ctx.now, createdBy: ctx.user.id, updatedAt: ctx.now, updatedBy: ctx.user.id,
    });
    await insertLines(tx, id, priced, units, allocated);

    if (pending) {
      await openOpenSaleRequest(tx, ctx, { saleId: id, grounds, reason: reason ?? '', expiryMinutes: limits.approvalExpiryMinutes, total: priced.total, buyer: buyer.name });
    } else {
      const number = await createDeliveryDocument(tx, ctx, id, { open: true });
      await audit(tx, ctx, {
        action: 'sales.completed', entityType: 'sale', entityId: id,
        after: { open: true, buyer, total: priced.total, discount: priced.discount, document: number, payment: input.payment?.method ?? null },
      });
    }
    return viewSale(tx, ctx, id);
  });
}

/**
 * SAL-016 (ADR-0052): an open sale that must wait. Everyone who approves open
 * sales is told at once; the first decision wins; it expires as a discount
 * request does.
 */
async function openOpenSaleRequest(
  tx: Tx, ctx: Ctx, input: { saleId: string; grounds: OpenSaleGround[]; reason: string; expiryMinutes: number; total: Money; buyer: string | null },
): Promise<void> {
  const expiresAt = new Date(ctx.now.getTime() + input.expiryMinutes * 60_000);
  await tx.insert(discountApprovalRequests).values({
    saleId: input.saleId, kind: 'OPEN_SALE', grounds: input.grounds, reason: input.reason, requestedAt: ctx.now, requestedBy: ctx.user.id,
    expiresAt, branchId: ctx.branchId, createdAt: ctx.now,
  });
  const sale = await loadSale(tx, ctx, input.saleId);
  await notify(tx, ctx, { permission: 'sales.approve_open_sale' }, 'OPEN_SALE_REQUESTED',
    { seller: sale.seller.name, total: input.total, buyer: input.buyer ?? '' }, `/console/sales/${input.saleId}`, input.saleId);
  await audit(tx, ctx, {
    action: 'sales.open_sale_requested', entityType: 'sale', entityId: input.saleId,
    after: { total: input.total, grounds: input.grounds, reason: input.reason, expiresAt },
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
    { store: input.storeName, seller: sale.seller.name, total: input.priced.total }, `/console/sales/${input.saleId}`, input.saleId);
  await audit(tx, ctx, {
    action: 'sales.discount_requested', entityType: 'sale', entityId: input.saleId,
    after: {
      storeId: sale.store?.id ?? null, channel: sale.channel, total: input.priced.total, reason: input.reason, expiresAt,
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
    let usesOverride = false;
    if (row.storeId) {
      const store = await loadStore(tx, ctx, row.storeId);
      ({ usesOverride } = assertSaleCredit(store.credit, store.creditMode, row.total as Money, { paidNow: input.payment ? money(input.payment.amount) : undefined }));
    } else {
      // SAL-013: an approved open sale is paid in full as it completes.
      assertPaidInFull(row.total as Money, input.payment ? money(input.payment.amount) : null);
    }
    const allocations = await tx.select({ batchId: saleLineAllocations.batchId, quantity: saleLineAllocations.quantity })
      .from(saleLineAllocations).innerJoin(saleLines, eq(saleLines.id, saleLineAllocations.saleLineId)).where(eq(saleLines.saleId, id));
    const posted = await settle(tx, ctx, { id, storeId: row.storeId, vehicleId, total: row.total as Money },
      allocations.map((a) => ({ batchId: a.batchId, quantity: a.quantity as Quantity })), { usesOverride, payment: input.payment });
    await tx.update(sales).set({
      status, ...posted, completedAt: ctx.now, updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1,
    }).where(and(eq(sales.id, id), eq(sales.version, row.version)));
    const number = await createDeliveryDocument(tx, ctx, id, { open: row.storeId === null });
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
    await endRequest(tx, 'DISCOUNT_APPROVAL_REQUESTED', [id], 'WITHDRAWN', ctx.user.id, ctx.now);
    await endRequest(tx, 'OPEN_SALE_REQUESTED', [id], 'WITHDRAWN', ctx.user.id, ctx.now);
    await audit(tx, ctx, { action: 'sales.withdrawn', entityType: 'sale', entityId: id, before: { status: row.status } });
    return viewSale(tx, ctx, id);
  });
}
