import {
  analyticsRange, DomainError, packsHeld, quantity, type ApprovalKind, type CountUnit, type CreditMode, type DeliveryDocumentStatus,
  type DiscountRequestStatus, type DocumentSendChannel, type Money, type OpenSaleGround, type PackSize, type Percent, type SaleCancelReason,
  type SaleChannel, type SaleStatus,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { aliasedTable, and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { sizeOf } from '../catalogue';
import type { Ctx } from '../context';
import { decodeCursor, encodeCursor, inOrder, pageLimit, type Executor } from '../platform';
import { unitsOf } from '../vehicles';

const {
  sales, saleLines, saleLineAllocations, discountApprovalRequests, deliveryDocuments, deliveryDocumentSends, stores, users, vehicles,
  skus, products, varieties, productTypes, batches, payments, creditOverrides, dispatchOrders,
} = schema;

type Named = { readonly nameEn: string; readonly nameAr: string };
type Person = { readonly id: string; readonly name: string };

export type SaleLine = {
  readonly id: string; readonly skuId: string; readonly code: string; readonly product: Named; readonly variety: Named | null;
  readonly size: PackSize; readonly countUnit: CountUnit; readonly packs: number; readonly unitPrice: Money;
  readonly ceiling: Percent; readonly requestedDiscount: Percent; readonly discount: Percent;
  readonly gross: Money; readonly discountAmount: Money; readonly total: Money;
  /** SAL-008: the batches this line was — or, while pending, is held — against. */
  readonly batches: readonly { readonly batchId: string; readonly lotNumber: string | null; readonly expiresOn: string | null; readonly packs: number }[];
};

export type DiscountRequest = {
  readonly id: string; readonly status: DiscountRequestStatus; readonly reason: string;
  /** ADR-0052: a discount above the ceiling, or an open sale — and, for an open sale, why it waits. */
  readonly kind: ApprovalKind; readonly grounds: readonly OpenSaleGround[];
  readonly requestedAt: Date; readonly expiresAt: Date; readonly decidedAt: Date | null; readonly decidedBy: Person | null;
  readonly comment: string | null; readonly closedAt: Date | null;
};

export type DeliveryDocumentInfo = {
  readonly id: string; readonly number: string; readonly status: DeliveryDocumentStatus; readonly renderedAt: Date | null;
  /** ADR-0049: the PDF deleted under the storage policy, and whether it is kept forever instead. */
  readonly purgedAt: Date | null; readonly kept: boolean;
  readonly sends: readonly { readonly channel: DocumentSendChannel; readonly toAddress: string | null; readonly sentAt: Date; readonly by: string }[];
};

export type Sale = {
  readonly id: string; readonly status: SaleStatus; readonly businessDate: string;
  /** ADR-0038: from the vehicle, or dispatched from the warehouse. */ readonly channel: SaleChannel;
  /** Who raised it — the seller, or a manager on their behalf (DSP-015). */ readonly raisedBy: string | null;
  /** Null for an open sale (ADR-0052), which has its buyer and place instead. */
  readonly store: { readonly id: string; readonly name: string; readonly ownerName: string; readonly contactNumber: string; readonly creditMode: CreditMode } | null;
  readonly open: OpenSaleInfo | null;
  readonly seller: Person; readonly vehicle: { readonly id: string; readonly registration: string } | null;
  /** The dispatch order carrying it, if any. */ readonly dispatchOrder: { readonly id: string; readonly number: string } | null;
  readonly gross: Money; readonly discount: Money; readonly total: Money;
  readonly lines: readonly SaleLine[];
  /** PRC-017: the request and its decision, if the sale needed one. */ readonly approval: DiscountRequest | null;
  /** SAL-006: bill to bill, settled at completion. */
  /** ADR-0047: money taken with the sale, if any, and the voucher handed over for it. */
  readonly payment: {
    readonly id: string; readonly number: string; readonly method: 'CASH' | 'BANK_TRANSFER'; readonly amount: Money; readonly reference: string | null;
    readonly voucher: { readonly number: string; readonly photoId: string } | null;
  } | null;
  /** SAL-009, CRD-007 */ readonly creditOverride: { readonly reason: string; readonly grantedBy: string } | null;
  readonly document: DeliveryDocumentInfo | null;
  readonly createdAt: Date; readonly completedAt: Date | null; readonly cancelledAt: Date | null; readonly cancelReason: SaleCancelReason | null;
  readonly version: number;
};

/** SAL-012: an open sale's buyer, as given, and where it was made. */
export type OpenSaleInfo = {
  readonly buyerName: string | null; readonly buyerPhone: string | null;
  readonly location: { readonly lat: number; readonly lng: number; readonly accuracyM: number | null };
};

export type SaleSummary = {
  readonly id: string; readonly status: SaleStatus; readonly channel: SaleChannel;
  /** Null for an open sale, whose buyer's name — if given — is in `buyerName` (ADR-0052). */
  readonly store: { readonly id: string; readonly name: string } | null; readonly open: boolean; readonly buyerName: string | null;
  readonly seller: Person;
  readonly total: Money; readonly discount: Money; readonly createdAt: Date; readonly completedAt: Date | null;
  readonly documentNumber: string | null; readonly approvalStatus: DiscountRequestStatus | null; readonly expiresAt: Date | null;
  readonly cancelReason: SaleCancelReason | null;
  /** ADR-0038: the dispatch order carrying a dispatch sale. */ readonly dispatchOrderId: string | null;
  readonly vehicle: { readonly id: string; readonly registration: string } | null;
};

/**
 * PERMISSIONS §3.1: a seller sees the sales attributed to them; `sales.view_all`
 * sees every sale; an approver sees the sales that asked for a decision.
 */
function visibility(ctx: Ctx): SQL | undefined {
  if (ctx.permissions.has('sales.view_all')) return undefined;
  const own = or(eq(sales.sellerId, ctx.user.id), eq(sales.createdBy, ctx.user.id));
  // ADR-0052: each approver, the requests of the kinds they decide.
  const decides = [
    ...(ctx.permissions.has('sales.approve_discount') ? ['DISCOUNT' as const] : []),
    ...(ctx.permissions.has('sales.approve_open_sale') ? ['OPEN_SALE' as const] : []),
  ];
  if (decides.length === 0) return own;
  return or(own, sql`exists (select 1 from ${discountApprovalRequests} where ${discountApprovalRequests.saleId} = ${sales.id} and ${inArray(discountApprovalRequests.kind, decides)})`);
}

/** SAL-012: what a sale row says about its open buyer, if it has none of a store's. */
const openOf = (s: typeof sales.$inferSelect): OpenSaleInfo | null => (s.storeId === null && s.latitude !== null && s.longitude !== null ? {
  buyerName: s.buyerName, buyerPhone: s.buyerPhone,
  location: { lat: Number(s.latitude), lng: Number(s.longitude), accuracyM: s.locationAccuracyM },
} : null);

const seller = aliasedTable(users, 'seller');
const decider = aliasedTable(users, 'decider');
const granter = aliasedTable(users, 'granter');
const sender = aliasedTable(users, 'sender');

/** One sale, if the caller may see it — otherwise it does not exist for them (SECURITY §3). */
export async function loadSale(db: Executor, ctx: Ctx, id: string): Promise<Sale> {
  const [row] = await db.select({
    s: sales, storeName: stores.name, ownerName: stores.ownerName, contactNumber: stores.contactNumber, creditMode: stores.creditMode,
    sellerName: seller.name, registration: vehicles.registration, orderId: dispatchOrders.id, orderNumber: dispatchOrders.number,
  }).from(sales)
    .leftJoin(stores, eq(stores.id, sales.storeId)).innerJoin(seller, eq(seller.id, sales.sellerId)).leftJoin(vehicles, eq(vehicles.id, sales.vehicleId))
    .leftJoin(dispatchOrders, eq(dispatchOrders.saleId, sales.id))
    .where(and(eq(sales.id, id), visibility(ctx)));
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'sale', id });
  const s = row.s;

  const [lineRows, allocationRows, [request], [payment], [override], [document]] = await inOrder([
    db.select({ l: saleLines, sku: skus, productEn: products.nameEn, productAr: products.nameAr, varietyEn: varieties.nameEn, varietyAr: varieties.nameAr, countUnit: productTypes.countUnit })
      .from(saleLines).innerJoin(skus, eq(skus.id, saleLines.skuId)).innerJoin(products, eq(products.id, skus.productId))
      .innerJoin(productTypes, eq(productTypes.id, products.productTypeId)).leftJoin(varieties, eq(varieties.id, skus.varietyId))
      .where(eq(saleLines.saleId, id)).orderBy(asc(skus.code)),
    db.select({ a: saleLineAllocations, lotNumber: batches.lotNumber, expiresOn: batches.expiresOn })
      .from(saleLineAllocations).innerJoin(saleLines, eq(saleLines.id, saleLineAllocations.saleLineId)).innerJoin(batches, eq(batches.id, saleLineAllocations.batchId))
      .where(eq(saleLines.saleId, id)).orderBy(sql`${batches.expiresOn} asc nulls last`),
    db.select({ r: discountApprovalRequests, deciderName: decider.name }).from(discountApprovalRequests)
      .leftJoin(decider, eq(decider.id, discountApprovalRequests.decidedBy)).where(eq(discountApprovalRequests.saleId, id)),
    s.paymentId ? db.select().from(payments).where(eq(payments.id, s.paymentId)) : Promise.resolve([]),
    s.creditOverrideId
      ? db.select({ reason: creditOverrides.reason, grantedBy: granter.name }).from(creditOverrides).innerJoin(granter, eq(granter.id, creditOverrides.grantedBy))
        .where(eq(creditOverrides.id, s.creditOverrideId))
      : Promise.resolve([]),
    db.select().from(deliveryDocuments).where(eq(deliveryDocuments.saleId, id)),
  ]);
  const sends = document
    ? await db.select({ channel: deliveryDocumentSends.channel, toAddress: deliveryDocumentSends.toAddress, sentAt: deliveryDocumentSends.sentAt, by: sender.name })
      .from(deliveryDocumentSends).innerJoin(sender, eq(sender.id, deliveryDocumentSends.sentBy))
      .where(eq(deliveryDocumentSends.documentId, document.id)).orderBy(asc(deliveryDocumentSends.sentAt), asc(deliveryDocumentSends.id))
    : [];

  return {
    id: s.id, status: s.status, businessDate: s.businessDate, channel: s.channel, raisedBy: s.createdBy,
    store: s.storeId && row.storeName !== null && row.ownerName !== null && row.contactNumber !== null && row.creditMode !== null
      ? { id: s.storeId, name: row.storeName, ownerName: row.ownerName, contactNumber: row.contactNumber, creditMode: row.creditMode }
      : null,
    open: openOf(s),
    seller: { id: s.sellerId, name: row.sellerName },
    vehicle: s.vehicleId && row.registration ? { id: s.vehicleId, registration: row.registration } : null,
    dispatchOrder: row.orderId && row.orderNumber ? { id: row.orderId, number: row.orderNumber } : null,
    gross: s.gross as Money, discount: s.discount as Money, total: s.total as Money,
    lines: lineRows.map((r) => {
      const size = sizeOf(r.sku);
      return {
        id: r.l.id, skuId: r.l.skuId, code: r.sku.code,
        product: { nameEn: r.productEn, nameAr: r.productAr },
        variety: r.varietyEn !== null && r.varietyAr !== null ? { nameEn: r.varietyEn, nameAr: r.varietyAr } : null,
        size, countUnit: r.countUnit, packs: r.l.packs, unitPrice: r.l.unitPrice as Money,
        ceiling: r.l.ceiling as Percent, requestedDiscount: r.l.requestedDiscount as Percent, discount: r.l.discount as Percent,
        gross: r.l.gross as Money, discountAmount: r.l.discountAmount as Money, total: r.l.total as Money,
        batches: allocationRows.filter((a) => a.a.saleLineId === r.l.id).map((a) => ({
          batchId: a.a.batchId, lotNumber: a.lotNumber, expiresOn: a.expiresOn, packs: packsHeld(quantity(a.a.quantity), unitsOf(size)),
        })),
      };
    }),
    approval: request ? {
      id: request.r.id, status: request.r.status, reason: request.r.reason, kind: request.r.kind, grounds: request.r.grounds ?? [],
      requestedAt: request.r.requestedAt, expiresAt: request.r.expiresAt,
      decidedAt: request.r.decidedAt, decidedBy: request.r.decidedBy && request.deciderName ? { id: request.r.decidedBy, name: request.deciderName } : null,
      comment: request.r.comment, closedAt: request.r.closedAt,
    } : null,
    payment: payment ? {
      id: payment.id, number: payment.number, method: payment.method, amount: payment.amount as Money, reference: payment.reference,
      voucher: payment.voucherNumber && payment.voucherPhotoId ? { number: payment.voucherNumber, photoId: payment.voucherPhotoId } : null,
    } : null,
    creditOverride: override ?? null,
    document: document ? {
      id: document.id, number: document.number, status: document.status, renderedAt: document.renderedAt,
      purgedAt: document.purgedAt, kept: document.keptAt !== null, sends,
    } : null,
    createdAt: s.createdAt, completedAt: s.completedAt, cancelledAt: s.cancelledAt, cancelReason: s.cancelReason, version: s.version,
  };
}

export type SaleFilter = {
  readonly status?: SaleStatus | undefined; readonly awaitingDecision?: boolean | undefined;
  readonly storeId?: string | undefined; readonly sellerId?: string | undefined;
  /** ADR-0048: completed within these Riyadh days, both included — given together. */
  readonly from?: string | undefined; readonly to?: string | undefined;
  readonly vehicleId?: string | undefined; readonly channel?: SaleChannel | undefined;
  /** ADR-0052: open sales only. */ readonly open?: boolean | undefined;
  /** ADR-0048: sales with at least one line of this product, or of this category. */
  readonly productId?: string | undefined; readonly categoryId?: string | undefined;
  readonly cursor?: string | undefined; readonly limit?: number | undefined;
};

/** Newest first. A seller's own; with `sales.view_all`, everyone's; an approver, the requests. */
export async function querySales(db: Executor, ctx: Ctx, filter: SaleFilter): Promise<{ items: SaleSummary[]; nextCursor: string | null }> {
  const limit = pageLimit(filter.limit);
  const where: (SQL | undefined)[] = [visibility(ctx)];
  if (filter.status) where.push(eq(sales.status, filter.status));
  if (filter.awaitingDecision) where.push(eq(discountApprovalRequests.status, 'PENDING'));
  if (filter.storeId) where.push(eq(sales.storeId, filter.storeId));
  if (filter.sellerId) where.push(eq(sales.sellerId, filter.sellerId));
  if (filter.from !== undefined || filter.to !== undefined) {
    const range = analyticsRange(filter.from ?? '', filter.to ?? '');
    where.push(gte(sales.completedAt, range.start), lt(sales.completedAt, range.end));
  }
  if (filter.vehicleId) where.push(eq(sales.vehicleId, filter.vehicleId));
  if (filter.channel) where.push(eq(sales.channel, filter.channel));
  if (filter.open) where.push(isNull(sales.storeId));
  if (filter.productId || filter.categoryId) {
    where.push(sql`exists (select 1 from ${saleLines} join ${skus} on ${skus.id} = ${saleLines.skuId} join ${products} on ${products.id} = ${skus.productId}
      where ${saleLines.saleId} = ${sales.id}${filter.productId ? sql` and ${skus.productId} = ${filter.productId}` : sql``}${filter.categoryId ? sql` and ${products.categoryId} = ${filter.categoryId}` : sql``})`);
  }
  if (filter.cursor) {
    const [at, id] = decodeCursor(filter.cursor, 2) as [string, string];
    where.push(or(lt(sales.createdAt, new Date(at)), and(eq(sales.createdAt, new Date(at)), lt(sales.id, id))));
  }
  const rows = await db.select({
    s: sales, storeName: stores.name, sellerName: seller.name, documentNumber: deliveryDocuments.number,
    approvalStatus: discountApprovalRequests.status, expiresAt: discountApprovalRequests.expiresAt, dispatchOrderId: dispatchOrders.id,
    registration: vehicles.registration,
  }).from(sales)
    .leftJoin(stores, eq(stores.id, sales.storeId)).innerJoin(seller, eq(seller.id, sales.sellerId))
    .leftJoin(deliveryDocuments, eq(deliveryDocuments.saleId, sales.id)).leftJoin(discountApprovalRequests, eq(discountApprovalRequests.saleId, sales.id))
    .leftJoin(dispatchOrders, eq(dispatchOrders.saleId, sales.id)).leftJoin(vehicles, eq(vehicles.id, sales.vehicleId))
    .where(and(...where)).orderBy(desc(sales.createdAt), desc(sales.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.s.id, status: r.s.status, channel: r.s.channel,
      store: r.s.storeId && r.storeName !== null ? { id: r.s.storeId, name: r.storeName } : null, open: r.s.storeId === null, buyerName: r.s.buyerName,
      seller: { id: r.s.sellerId, name: r.sellerName },
      total: r.s.total as Money, discount: r.s.discount as Money, createdAt: r.s.createdAt, completedAt: r.s.completedAt,
      documentNumber: r.documentNumber, approvalStatus: r.approvalStatus, expiresAt: r.expiresAt, cancelReason: r.s.cancelReason,
      dispatchOrderId: r.dispatchOrderId,
      vehicle: r.s.vehicleId && r.registration ? { id: r.s.vehicleId, registration: r.registration } : null,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.s.createdAt.toISOString(), last.s.id]) : null,
  };
}

/** Sales currently holding stock on a vehicle, oldest first — for the seller's screens and check-out. */
export async function holdingSaleIds(db: Executor, sellerId: string): Promise<string[]> {
  const rows = await db.select({ id: sales.id }).from(sales)
    .where(and(eq(sales.sellerId, sellerId), inArray(sales.status, ['PENDING_DISCOUNT_APPROVAL', 'DISCOUNT_APPROVED'])))
    .orderBy(asc(sales.createdAt));
  return rows.map((r) => r.id);
}
