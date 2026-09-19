import {
  DomainError, isUnconfirmed, lineAmounts, packsHeld, quantity, sumMoney, type ConfirmationMode, type CountUnit, type DispatchCloseReason,
  type DispatchEventType, type DispatchStatus, type LostClaimStatus, type Money, type PackSize, type Percent, type SaleStatus,
  type ShortfallResolution, type CreditMode,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { aliasedTable, and, asc, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { sizeOf } from '../catalogue';
import { authorizeAny, type Ctx } from '../context';
import { decodeCursor, encodeCursor, inOrder, pageLimit, type Executor } from '../platform';
import { getDb } from '../runtime';
import { readSettings } from '../system';
import { unitsOf } from '../vehicles';
import { warehousePacks } from './stock';

const {
  dispatchOrders, dispatchOrderLines, dispatchLineBatches, dispatchOrderEvents, lostOrderClaims, sales, saleLines, stores, users,
  skus, products, varieties, productTypes, batches,
} = schema;

type Named = { readonly nameEn: string; readonly nameAr: string };
type Person = { readonly id: string; readonly name: string };

export const DISPATCH_READERS = [
  'sales.request_dispatch', 'sales.create_order_for_seller', 'sales.fulfil_dispatch', 'sales.confirm_dispatch_receipt',
  'sales.approve_lost_order', 'sales.view_all',
] as const;

export type DispatchLine = {
  readonly id: string; readonly saleLineId: string; readonly skuId: string; readonly code: string; readonly product: Named; readonly variety: Named | null;
  readonly size: PackSize; readonly countUnit: CountUnit;
  /** Packs ordered. */ readonly packs: number; readonly unitPrice: Money; readonly discount: Percent; readonly orderedTotal: Money;
  /** DSP-011: once receipt is confirmed. */ readonly receivedPacks: number | null; readonly shortPacks: number | null; readonly damagedPacks: number | null;
  /** DSP-007: what was released, batch by batch. */
  readonly batches: readonly { readonly batchId: string; readonly lotNumber: string | null; readonly expiresOn: string | null; readonly packs: number }[];
  /** OQ-019: what the warehouse could release now, while the order waits — shown, not reserved. */ readonly warehousePacks: number | null;
};

export type DispatchOrder = {
  readonly id: string; readonly number: string; readonly status: DispatchStatus; readonly version: number; readonly createdAt: Date;
  readonly store: { readonly id: string; readonly name: string; readonly creditMode: CreditMode }; readonly seller: Person; readonly raisedBy: Person;
  /** DSP-015: raised by a manager on the seller's behalf. */ readonly forSeller: boolean;
  readonly sale: { readonly id: string; readonly status: SaleStatus; readonly gross: Money; readonly discount: Money; readonly total: Money };
  readonly lines: readonly DispatchLine[]; readonly orderedTotal: Money;
  /** DSP-004: an advisory label, not a lock. */ readonly handledBy: Person | null; readonly handledAt: Date | null;
  readonly releasedAt: Date | null; readonly releasedBy: Person | null; readonly transportSlipMediaId: string | null; readonly transportNote: string | null;
  readonly confirmedAt: Date | null; readonly confirmationMode: ConfirmationMode | null; readonly resolution: ShortfallResolution | null;
  readonly closedAt: Date | null; readonly closeReason: DispatchCloseReason | null; readonly cancelReason: string | null;
  /** DSP-014 */ readonly unconfirmed: boolean;
  readonly claims: readonly {
    readonly id: string; readonly status: LostClaimStatus; readonly reason: string; readonly raisedBy: Person; readonly raisedAt: Date;
    readonly decidedBy: string | null; readonly decidedAt: Date | null; readonly comment: string | null;
  }[];
  readonly events: readonly { readonly type: DispatchEventType; readonly actor: string | null; readonly note: string | null; readonly occurredAt: Date }[];
};

export type DispatchSummary = {
  readonly id: string; readonly number: string; readonly status: DispatchStatus; readonly store: { readonly id: string; readonly name: string };
  readonly seller: Person; readonly raisedBy: Person; readonly total: Money; readonly handledBy: Person | null; readonly releasedAt: Date | null;
  readonly unconfirmed: boolean; readonly pendingClaim: boolean; readonly closeReason: DispatchCloseReason | null; readonly createdAt: Date;
};

const pendingClaim = sql<boolean>`exists (select 1 from ${lostOrderClaims} where ${lostOrderClaims.orderId} = ${dispatchOrders.id} and ${lostOrderClaims.status} = 'PENDING')`;
const anyClaim = sql<boolean>`exists (select 1 from ${lostOrderClaims} where ${lostOrderClaims.orderId} = ${dispatchOrders.id})`;

/**
 * PERMISSIONS §3.1: the seller of record and whoever raised it see an order;
 * those who fulfil dispatch, or see every sale, see all; a lost-order
 * approver sees those with a claim.
 */
function visibility(ctx: Ctx): SQL | undefined {
  if (ctx.permissions.has('sales.fulfil_dispatch') || ctx.permissions.has('sales.view_all')) return undefined;
  const parts: SQL[] = [eq(dispatchOrders.sellerId, ctx.user.id), eq(dispatchOrders.raisedBy, ctx.user.id)];
  if (ctx.permissions.has('sales.approve_lost_order')) parts.push(anyClaim);
  return or(...parts);
}

const seller = aliasedTable(users, 'seller');
const raiser = aliasedTable(users, 'raiser');
const handler = aliasedTable(users, 'handler');
const releaser = aliasedTable(users, 'releaser');
const claimant = aliasedTable(users, 'claimant');
const decider = aliasedTable(users, 'decider');
const actor = aliasedTable(users, 'actor');

const person = (id: string | null, name: string | null): Person | null => (id && name ? { id, name } : null);

/** One order, if the caller may see it — otherwise it does not exist for them (SECURITY §3). */
export async function loadOrder(db: Executor, ctx: Ctx, id: string, now = ctx.now): Promise<DispatchOrder> {
  const [row] = await db.select({
    o: dispatchOrders, saleStatus: sales.status, gross: sales.gross, discount: sales.discount, total: sales.total, storeName: stores.name, creditMode: stores.creditMode, sellerName: seller.name, raiserName: raiser.name, handlerName: handler.name, releaserName: releaser.name,
  }).from(dispatchOrders)
    .innerJoin(sales, eq(sales.id, dispatchOrders.saleId)).innerJoin(stores, eq(stores.id, dispatchOrders.storeId))
    // Left joins throughout: mixing inner and left joins of one table's aliases types as never in Drizzle 0.45.
    .leftJoin(seller, eq(seller.id, dispatchOrders.sellerId)).leftJoin(raiser, eq(raiser.id, dispatchOrders.raisedBy))
    .leftJoin(handler, eq(handler.id, dispatchOrders.handledBy)).leftJoin(releaser, eq(releaser.id, dispatchOrders.releasedBy))
    .where(and(eq(dispatchOrders.id, id), visibility(ctx)));
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'dispatch_order', id });
  const o = row.o;
  const [lineRows, batchRows, claimRows, eventRows] = await inOrder([
    db.select({ ol: dispatchOrderLines, sl: saleLines, sku: skus, productEn: products.nameEn, productAr: products.nameAr, varietyEn: varieties.nameEn, varietyAr: varieties.nameAr, countUnit: productTypes.countUnit })
      .from(dispatchOrderLines).innerJoin(saleLines, eq(saleLines.id, dispatchOrderLines.saleLineId)).innerJoin(skus, eq(skus.id, saleLines.skuId))
      .innerJoin(products, eq(products.id, skus.productId)).innerJoin(productTypes, eq(productTypes.id, products.productTypeId)).leftJoin(varieties, eq(varieties.id, skus.varietyId))
      .where(eq(dispatchOrderLines.orderId, id)).orderBy(asc(skus.code)),
    db.select({ b: dispatchLineBatches, lotNumber: batches.lotNumber, expiresOn: batches.expiresOn })
      .from(dispatchLineBatches).innerJoin(dispatchOrderLines, eq(dispatchOrderLines.id, dispatchLineBatches.orderLineId)).innerJoin(batches, eq(batches.id, dispatchLineBatches.batchId))
      .where(eq(dispatchOrderLines.orderId, id)).orderBy(sql`${batches.expiresOn} asc nulls last`),
    db.select({ c: lostOrderClaims, claimantName: claimant.name, deciderName: decider.name }).from(lostOrderClaims)
      .leftJoin(claimant, eq(claimant.id, lostOrderClaims.raisedBy)).leftJoin(decider, eq(decider.id, lostOrderClaims.decidedBy))
      .where(eq(lostOrderClaims.orderId, id)).orderBy(asc(lostOrderClaims.raisedAt)),
    db.select({ e: dispatchOrderEvents, actorName: actor.name }).from(dispatchOrderEvents).leftJoin(actor, eq(actor.id, dispatchOrderEvents.actorId))
      .where(eq(dispatchOrderEvents.orderId, id)).orderBy(asc(dispatchOrderEvents.occurredAt), asc(dispatchOrderEvents.id)),
  ]);
  const waiting = o.status === 'REQUESTED' || o.status === 'BEING_HANDLED';
  const available = waiting ? await warehousePacks(db, lineRows.map((l) => l.sl.skuId), now) : null;
  const settings = await readSettings(db);
  const lines = lineRows.map((r): DispatchLine => {
    const size = sizeOf(r.sku);
    return {
      id: r.ol.id, saleLineId: r.sl.id, skuId: r.sl.skuId, code: r.sku.code,
      product: { nameEn: r.productEn, nameAr: r.productAr },
      variety: r.varietyEn !== null && r.varietyAr !== null ? { nameEn: r.varietyEn, nameAr: r.varietyAr } : null,
      size, countUnit: r.countUnit, packs: r.ol.packs, unitPrice: r.sl.unitPrice as Money, discount: r.sl.discount as Percent,
      orderedTotal: lineAmounts(r.sl.unitPrice as Money, r.ol.packs, r.sl.discount as Percent).total,
      receivedPacks: r.ol.receivedPacks, shortPacks: r.ol.shortPacks, damagedPacks: r.ol.damagedPacks,
      batches: batchRows.filter((b) => b.b.orderLineId === r.ol.id).map((b) => ({
        batchId: b.b.batchId, lotNumber: b.lotNumber, expiresOn: b.expiresOn, packs: packsHeld(quantity(b.b.quantity), unitsOf(size)),
      })),
      warehousePacks: available?.get(r.sl.skuId) ?? null,
    };
  });
  return {
    id: o.id, number: o.number, status: o.status, version: o.version, createdAt: o.createdAt,
    store: { id: o.storeId, name: row.storeName, creditMode: row.creditMode }, seller: { id: o.sellerId, name: row.sellerName ?? '' }, raisedBy: { id: o.raisedBy, name: row.raiserName ?? '' },
    forSeller: o.raisedBy !== o.sellerId,
    sale: { id: o.saleId, status: row.saleStatus, gross: row.gross as Money, discount: row.discount as Money, total: row.total as Money },
    lines, orderedTotal: sumMoney(lines.map((l) => l.orderedTotal)),
    handledBy: person(o.handledBy, row.handlerName), handledAt: o.handledAt,
    releasedAt: o.releasedAt, releasedBy: person(o.releasedBy, row.releaserName), transportSlipMediaId: o.transportSlipMediaId, transportNote: o.transportNote,
    confirmedAt: o.confirmedAt, confirmationMode: o.confirmationMode, resolution: o.resolution,
    closedAt: o.closedAt, closeReason: o.closeReason, cancelReason: o.cancelReason,
    unconfirmed: o.status === 'RELEASED' && isUnconfirmed(o.releasedAt, now, settings['dispatch.unconfirmed_after_days']),
    claims: claimRows.map((c) => ({
      id: c.c.id, status: c.c.status, reason: c.c.reason, raisedBy: { id: c.c.raisedBy, name: c.claimantName ?? '' }, raisedAt: c.c.raisedAt,
      decidedBy: c.deciderName, decidedAt: c.c.decidedAt, comment: c.c.comment,
    })),
    events: eventRows.map((e) => ({ type: e.e.type, actor: e.actorName, note: e.e.note, occurredAt: e.e.occurredAt })),
  };
}

export type DispatchFilter = {
  readonly status?: DispatchStatus | undefined; readonly unconfirmed?: boolean | undefined; readonly open?: boolean | undefined;
  readonly cursor?: string | undefined; readonly limit?: number | undefined;
};

/** RPT-009, DSP-014: newest first; `open` hides closed orders; `unconfirmed` shows the flagged ones. */
export async function listDispatchOrders(ctx: Ctx, filter: DispatchFilter = {}): Promise<{ items: DispatchSummary[]; nextCursor: string | null }> {
  authorizeAny(ctx, DISPATCH_READERS);
  const db = ctx.tx ?? getDb();
  const days = (await readSettings(db))['dispatch.unconfirmed_after_days'];
  const cutoff = new Date(ctx.now.getTime() - days * 86_400_000);
  const limit = pageLimit(filter.limit);
  const where: (SQL | undefined)[] = [visibility(ctx)];
  if (filter.status) where.push(eq(dispatchOrders.status, filter.status));
  if (filter.open) where.push(inArray(dispatchOrders.status, ['REQUESTED', 'BEING_HANDLED', 'RELEASED', 'DELIVERED']));
  if (filter.unconfirmed) where.push(and(eq(dispatchOrders.status, 'RELEASED'), lt(dispatchOrders.releasedAt, cutoff)));
  if (filter.cursor) {
    const [at, id] = decodeCursor(filter.cursor, 2) as [string, string];
    where.push(or(lt(dispatchOrders.createdAt, new Date(at)), and(eq(dispatchOrders.createdAt, new Date(at)), lt(dispatchOrders.id, id))));
  }
  const rows = await db.select({
    o: dispatchOrders, total: sales.total, storeName: stores.name, sellerName: seller.name, raiserName: raiser.name, handlerName: handler.name, pendingClaim,
  }).from(dispatchOrders)
    .innerJoin(sales, eq(sales.id, dispatchOrders.saleId)).innerJoin(stores, eq(stores.id, dispatchOrders.storeId))
    .leftJoin(seller, eq(seller.id, dispatchOrders.sellerId)).leftJoin(raiser, eq(raiser.id, dispatchOrders.raisedBy))
    .leftJoin(handler, eq(handler.id, dispatchOrders.handledBy))
    .where(and(...where)).orderBy(desc(dispatchOrders.createdAt), desc(dispatchOrders.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.o.id, number: r.o.number, status: r.o.status, store: { id: r.o.storeId, name: r.storeName },
      seller: { id: r.o.sellerId, name: r.sellerName ?? '' }, raisedBy: { id: r.o.raisedBy, name: r.raiserName ?? '' }, total: r.total as Money,
      handledBy: person(r.o.handledBy, r.handlerName), releasedAt: r.o.releasedAt,
      unconfirmed: r.o.status === 'RELEASED' && isUnconfirmed(r.o.releasedAt, ctx.now, days), pendingClaim: r.pendingClaim,
      closeReason: r.o.closeReason, createdAt: r.o.createdAt,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.o.createdAt.toISOString(), last.o.id]) : null,
  };
}

/** One order the caller may see. */
export async function getDispatchOrder(ctx: Ctx, id: string): Promise<DispatchOrder> {
  authorizeAny(ctx, DISPATCH_READERS);
  return loadOrder(ctx.tx ?? getDb(), ctx, id);
}
