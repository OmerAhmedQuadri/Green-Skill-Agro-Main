import {
  applicableItemCeiling, assertSaleCredit, businessDate, dec, DomainError, isDomainError, percent, priceSale, toBaseUnits, transitionSale,
  type CountUnit, type CreditMode, type CreditStatus, type ErrorCode, type Money, type PackSize, type Percent, type StoreStatus,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { assertSellerWorking } from '../attendance';
import { sizeOf } from '../catalogue';
import { authorize, authorizeAny, type Ctx } from '../context';
import { warehouseAccount } from '../inventory';
import { notify } from '../notifications';
import { audit, inTx, likePattern, nextDocumentNumber, type Executor, type Tx } from '../platform';
import { getDb } from '../runtime';
import { lockOwnSale, openDiscountRequest, saleLimits, saleTerms, type SaleLimits } from '../sales';
import { consumeCreditOverride, loadStore, readingAsManager, type Store } from '../stores';
import { loadOrder, type DispatchOrder } from './access';
import { skuUnits, warehousePacks } from './stock';

const { sales, saleLines, dispatchOrders, dispatchOrderLines, dispatchOrderEvents, priceLists, priceListItems, skus, products, varieties, productTypes } = schema;

type Named = { readonly nameEn: string; readonly nameAr: string };

export type DispatchLineInput = { readonly skuId: string; readonly packs: number; readonly discount?: string | undefined };
export type RaiseInput = { readonly storeId: string; readonly lines: readonly DispatchLineInput[]; readonly approvalReason?: string | null | undefined };
export type RaiseResult = { readonly saleId: string; readonly orderId: string | null };

/** ADR-0038: dispatch sales of a store not yet delivered — committed against its credit, though not yet owed. */
export async function committedToDispatch(db: Executor, storeId: string, exceptSaleId?: string): Promise<Money> {
  const [row] = await db.select({ total: sql<string>`coalesce(sum(${sales.total}), 0)::numeric(14,2)` }).from(sales)
    .where(and(
      eq(sales.storeId, storeId), eq(sales.channel, 'DISPATCH'), inArray(sales.status, ['PENDING_DISCOUNT_APPROVAL', 'DISCOUNT_APPROVED', 'PENDING_DELIVERY']),
      exceptSaleId ? ne(sales.id, exceptSaleId) : undefined,
    ));
  return (row?.total ?? '0.00') as Money;
}

export type DispatchItem = {
  readonly skuId: string; readonly code: string; readonly product: Named; readonly variety: Named | null; readonly size: PackSize; readonly countUnit: CountUnit;
  readonly unitPrice: Money; readonly ceiling: Percent;
  /** OQ-019: what the warehouse could release now — shown, not reserved. */ readonly warehousePacks: number;
};

export type DispatchOptions = {
  readonly store: { readonly id: string; readonly name: string; readonly status: StoreStatus; readonly creditMode: CreditMode; readonly credit: CreditStatus };
  readonly seller: { readonly id: string; readonly name: string } | null;
  readonly notWorking: ErrorCode | null;
  readonly items: readonly DispatchItem[];
  readonly limits: SaleLimits;
  readonly canDiscount: boolean;
  /** Orders to this store still waiting for delivery. */ readonly committed: Money;
};

/** How the caller reaches a store: a seller their own; a manager raising for a seller, any (DSP-015). */
function storeReader(ctx: Ctx): Ctx {
  if (ctx.user.role === 'SELLER') return ctx;
  authorize(ctx, 'sales.create_order_for_seller');
  return readingAsManager(ctx);
}

/**
 * DSP-002: what the order screen needs, credit first — the same checks as a
 * sale — then every priced item, with what the warehouse holds of it.
 */
export async function dispatchOptions(ctx: Ctx, storeId: string): Promise<DispatchOptions> {
  authorizeAny(ctx, ['sales.request_dispatch', 'sales.create_order_for_seller']);
  const db = ctx.tx ?? getDb();
  const store = await loadStore(db, storeReader(ctx), storeId);
  const limits = await saleLimits(db);
  let notWorking: ErrorCode | null = null;
  try { await assertSellerWorking(db, ctx); } catch (error) {
    if (!isDomainError(error)) throw error;
    notWorking = error.code;
  }
  const priced = await db.select({ sku: skus, productEn: products.nameEn, productAr: products.nameAr, varietyEn: varieties.nameEn, varietyAr: varieties.nameAr, countUnit: productTypes.countUnit })
    .from(skus).innerJoin(products, eq(products.id, skus.productId)).innerJoin(productTypes, eq(productTypes.id, products.productTypeId))
    .leftJoin(varieties, eq(varieties.id, skus.varietyId))
    .where(and(eq(skus.isActive, true), sql`exists (select 1 from ${priceListItems} join ${priceLists} on ${priceLists.id} = ${priceListItems.priceListId}
      where ${priceListItems.skuId} = ${skus.id} and (${priceLists.id} = ${store.priceList.id} or ${priceLists.isBase}))`))
    .orderBy(asc(skus.code));
  const ids = priced.map((p) => p.sku.id);
  const terms = await saleTerms(db, store.priceList.id, ids);
  const packs = await warehousePacks(db, ids, ctx.now);
  const items = priced.flatMap((p): DispatchItem[] => {
    const term = terms.get(p.sku.id);
    if (!term?.unitPrice) return [];
    return [{
      skuId: p.sku.id, code: p.sku.code, product: { nameEn: p.productEn, nameAr: p.productAr },
      variety: p.varietyEn !== null && p.varietyAr !== null ? { nameEn: p.varietyEn, nameAr: p.varietyAr } : null,
      size: sizeOf(p.sku), countUnit: p.countUnit, unitPrice: term.unitPrice,
      ceiling: applicableItemCeiling(limits.orderCeiling, term.itemCeiling), warehousePacks: packs.get(p.sku.id) ?? 0,
    }];
  });
  return {
    store: { id: store.id, name: store.name, status: store.status, creditMode: store.creditMode, credit: store.credit },
    seller: store.seller, notWorking, items, limits, canDiscount: ctx.permissions.has('sales.apply_discount'),
    committed: await committedToDispatch(db, store.id),
  };
}

/**
 * DSP-003, ADR-0038: the dispatch order opens on a pending sale. Those who
 * fulfil dispatch are told at once; a seller who did not raise it is told it
 * was raised in their name (DSP-016).
 */
export async function openOrder(tx: Tx, ctx: Ctx, saleId: string): Promise<string> {
  const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId));
  if (!sale) throw new Error('sale missing for its order');
  const [store] = await tx.select({ name: schema.stores.name }).from(schema.stores).where(eq(schema.stores.id, sale.storeId));
  const id = newId();
  const number = await nextDocumentNumber(tx, 'DO', ctx.now);
  const raisedBy = sale.createdBy ?? ctx.user.id;
  await tx.insert(dispatchOrders).values({
    id, number, saleId, storeId: sale.storeId, sellerId: sale.sellerId, raisedBy, warehouseId: (await warehouseAccount(tx)).warehouseId,
    branchId: ctx.branchId, createdAt: ctx.now, createdBy: ctx.user.id, updatedAt: ctx.now, updatedBy: ctx.user.id,
  });
  const lines = await tx.select({ id: saleLines.id, packs: saleLines.packs }).from(saleLines).where(eq(saleLines.saleId, saleId));
  await tx.insert(dispatchOrderLines).values(lines.map((l) => ({ orderId: id, saleLineId: l.id, packs: l.packs })));
  await tx.insert(dispatchOrderEvents).values({ orderId: id, type: 'RAISED', actorId: ctx.user.id, occurredAt: ctx.now });
  const params = { number, store: store?.name ?? '' };
  await notify(tx, ctx, { permission: 'sales.fulfil_dispatch' }, 'DISPATCH_REQUESTED', params, `/console/dispatch/${id}`);
  if (raisedBy !== sale.sellerId) await notify(tx, ctx, { users: [sale.sellerId] }, 'DISPATCH_CREATED_FOR_YOU', params, `/field/orders/${id}`);
  await audit(tx, ctx, { action: 'dispatch.raised', entityType: 'dispatch_order', entityId: id, after: { number, saleId, storeId: sale.storeId, sellerId: sale.sellerId, raisedBy } });
  return id;
}

/** DSP-002, PRC-009: priced, checked and recorded exactly as a sale — then pending, not posted. */
async function raise(tx: Tx, ctx: Ctx, store: Store, sellerId: string, input: RaiseInput): Promise<RaiseResult> {
  const lines = input.lines.map((l) => ({ skuId: l.skuId, packs: l.packs, discount: percent(l.discount?.trim() || '0') }));
  if (lines.some((l) => dec(l.discount).gt(0)) && !ctx.permissions.has('sales.apply_discount')) throw new DomainError('DISCOUNT_NOT_PERMITTED');
  const reason = input.approvalReason?.trim() || null;
  assertSaleCredit(store.credit, store.creditMode, '0.00' as Money);
  const limits = await saleLimits(tx);
  const priced = priceSale(lines, await saleTerms(tx, store.priceList.id, lines.map((l) => l.skuId)), limits);
  if (priced.needsApproval && !reason) {
    throw new DomainError('DISCOUNT_ABOVE_CEILING', { lines: priced.lines.filter((l) => l.aboveCeiling).map((l) => ({ skuId: l.skuId, discount: l.discount, ceiling: l.ceiling })) });
  }
  const { usesOverride } = assertSaleCredit(store.credit, store.creditMode, priced.total, await committedToDispatch(tx, store.id));
  const units = await skuUnits(tx, lines.map((l) => l.skuId));
  const id = newId();
  const creditOverrideId = usesOverride ? await consumeCreditOverride(tx, ctx, store.id, id) : null;
  await tx.insert(sales).values({
    id, storeId: store.id, sellerId, channel: 'DISPATCH', vehicleId: null, status: priced.needsApproval ? 'PENDING_DISCOUNT_APPROVAL' : 'PENDING_DELIVERY',
    businessDate: businessDate(ctx.now), gross: priced.gross, discount: priced.discount, total: priced.total, creditOverrideId,
    branchId: ctx.branchId, createdAt: ctx.now, createdBy: ctx.user.id, updatedAt: ctx.now, updatedBy: ctx.user.id,
  });
  for (const line of priced.lines) {
    const u = units.get(line.skuId);
    if (!u) throw new DomainError('NOT_FOUND', { entity: 'sku', id: line.skuId });
    await tx.insert(saleLines).values({
      saleId: id, skuId: line.skuId, packs: line.packs, quantity: toBaseUnits(line.packs, u), unitPrice: line.unitPrice, ceiling: line.ceiling,
      requestedDiscount: line.discount, discount: line.discount, gross: line.gross, discountAmount: line.discountAmount, total: line.total,
    });
  }
  if (priced.needsApproval) {
    await openDiscountRequest(tx, ctx, { saleId: id, storeName: store.name, reason: reason ?? '', expiryMinutes: limits.approvalExpiryMinutes, priced });
    return { saleId: id, orderId: null };
  }
  return { saleId: id, orderId: await openOrder(tx, ctx, id) };
}

/** Workflow J (DSP-001..003): a seller asks the warehouse to deliver to one of their stores, during an open day (ATT-010). */
export async function raiseDispatchOrder(ctx: Ctx, input: RaiseInput): Promise<RaiseResult> {
  authorize(ctx, 'sales.request_dispatch');
  if (ctx.user.role !== 'SELLER') throw new DomainError('FORBIDDEN', { permission: 'sales.create_order_for_seller' });
  return inTx(ctx, async (tx) => {
    await assertSellerWorking(tx, ctx);
    return raise(tx, ctx, await loadStore(tx, ctx, input.storeId), ctx.user.id, input);
  });
}

/**
 * Workflow K (DSP-015, DSP-016): a manager raises an order for a store; it is
 * the store's current seller's sale, and they are told at once.
 */
export async function createOrderForSeller(ctx: Ctx, input: RaiseInput): Promise<RaiseResult> {
  authorize(ctx, 'sales.create_order_for_seller');
  return inTx(ctx, async (tx) => {
    const store = await loadStore(tx, readingAsManager(ctx), input.storeId);
    if (!store.seller) throw new DomainError('STORE_HAS_NO_SELLER', { storeId: store.id });
    return raise(tx, ctx, store, store.seller.id, input);
  });
}

/**
 * STATE-MACHINES §2, DISCOUNT_APPROVED → PENDING_DELIVERY: whoever raised an
 * approved dispatch sale sends it to the warehouse — credit checked again.
 */
export async function dispatchApprovedSale(ctx: Ctx, saleId: string, input: { version: number }): Promise<RaiseResult> {
  authorizeAny(ctx, ['sales.request_dispatch', 'sales.create_order_for_seller']);
  return inTx(ctx, async (tx) => {
    const row = await lockOwnSale(tx, ctx, saleId, input.version);
    if (row.channel !== 'DISPATCH') throw new DomainError('INVALID_TRANSITION', { from: row.status, action: 'dispatch' });
    const status = transitionSale(row.status, 'dispatch');
    const store = await loadStore(tx, readingAsManager(ctx), row.storeId);
    const { usesOverride } = assertSaleCredit(store.credit, store.creditMode, row.total as Money, await committedToDispatch(tx, store.id, saleId));
    const creditOverrideId = usesOverride && !row.creditOverrideId ? await consumeCreditOverride(tx, ctx, store.id, saleId) : row.creditOverrideId;
    await tx.update(sales).set({ status, creditOverrideId, updatedAt: ctx.now, updatedBy: ctx.user.id, version: row.version + 1 }).where(eq(sales.id, saleId));
    return { saleId, orderId: await openOrder(tx, ctx, saleId) };
  });
}

/** The order the caller just raised, read in its transaction. */
export async function readOrder(ctx: Ctx, id: string): Promise<DispatchOrder> {
  return loadOrder(ctx.tx ?? getDb(), ctx, id);
}

/**
 * DSP-015: the active stores a manager may raise an order for, with the
 * seller each is attributed to.
 */
export async function storesForOrders(ctx: Ctx, search = ''): Promise<{ id: string; name: string; seller: { id: string; name: string } | null }[]> {
  authorize(ctx, 'sales.create_order_for_seller');
  const term = search.trim();
  const rows = await getDb().select({ id: schema.stores.id, name: schema.stores.name, sellerId: schema.storeAssignments.sellerId, sellerName: schema.users.name })
    .from(schema.stores)
    .leftJoin(schema.storeAssignments, and(eq(schema.storeAssignments.storeId, schema.stores.id), sql`${schema.storeAssignments.endedAt} is null`))
    .leftJoin(schema.users, eq(schema.users.id, schema.storeAssignments.sellerId))
    .where(and(eq(schema.stores.status, 'ACTIVE'), term ? sql`${schema.stores.name} ilike ${likePattern(term)}` : undefined))
    .orderBy(asc(schema.stores.name)).limit(50);
  return rows.map((r) => ({ id: r.id, name: r.name, seller: r.sellerId && r.sellerName ? { id: r.sellerId, name: r.sellerName } : null }));
}
