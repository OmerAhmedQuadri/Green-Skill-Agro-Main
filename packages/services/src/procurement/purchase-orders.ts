import {
  DomainError, dec, isEditable, money, outstandingPacks, poNumber, templateFrom, transitionPo,
  type AttributeMode, type CountUnit, type Money, type PackSize, type PoAction, type PoCloseReason, type PoStatus, type PurchaseOrderId, type SkuId, type VendorId,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, desc, eq, ilike, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { sizeOf } from '../catalogue';
import { authorize, authorizeAny, type Ctx } from '../context';
import { audit, inTx, likePattern, pageLimit, type Executor } from '../platform';
import { getDb } from '../runtime';

const {
  purchaseOrders, purchaseOrderLines, purchaseOrderEvents, goodsReceiptLines, goodsReceipts, skus, products, varieties, productTypes,
  vendors, warehouses, documentSequences, users, productTypeAttributes,
} = schema;

/** Who may read purchase orders: anyone who raises, approves or receives them. */
const PO_READERS = ['procurement.view', 'procurement.manage_po', 'procurement.approve_po', 'inventory.receive_goods'] as const;

type Named = { readonly nameEn: string; readonly nameAr: string };

export type PoLine = {
  readonly id: string; readonly skuId: SkuId; readonly code: string; readonly product: Named; readonly variety: Named | null;
  readonly size: PackSize; readonly countUnit: CountUnit;
  readonly orderedPacks: number; readonly expectedUnitCost: Money;
  readonly receivedPacks: number;
  /** RCV-007: received − ordered; negative is short, positive is over. */ readonly variance: number;
  /** PO-004/006: still expected while the order is live. */ readonly outstandingPacks: number;
  /** What a receipt of this line must capture, from its product type's template (CAT-013, CAT-016). */
  readonly receiving: { readonly lotNumber: AttributeMode; readonly manufacturedOn: AttributeMode; readonly expiry: AttributeMode; readonly shelfLifeMonths: number | null };
};

export type PoSummary = {
  readonly id: PurchaseOrderId; readonly number: string; readonly status: PoStatus; readonly closeReason: PoCloseReason | null;
  readonly vendor: { readonly id: VendorId; readonly code: string; readonly name: string };
  readonly expectedArrival: string | null; readonly origin: 'MANUAL' | 'FORECAST';
  readonly lineCount: number; readonly orderValue: Money; readonly createdAt: Date; readonly version: number;
};

export type PoEvent = { readonly action: string; readonly from: PoStatus | null; readonly to: PoStatus; readonly reason: string | null; readonly actor: string; readonly at: Date };
export type PoReceipt = { readonly id: string; readonly receivedAt: Date; readonly source: 'MANUAL' | 'IMPORT'; readonly fileName: string | null; readonly packs: number; readonly by: string };

export type PoDetail = PoSummary & {
  readonly closeNote: string | null; readonly notes: string | null; readonly warehouseId: string;
  readonly lines: readonly PoLine[]; readonly events: readonly PoEvent[]; readonly receipts: readonly PoReceipt[];
};

const receivedPacks = sql<number>`coalesce((select sum(${goodsReceiptLines.packs}) from ${goodsReceiptLines} where ${goodsReceiptLines.purchaseOrderLineId} = ${purchaseOrderLines.id}), 0)::int`;

// ---------------------------------------------------------------- queries

export async function listPurchaseOrders(
  ctx: Ctx,
  filter: { status?: PoStatus | undefined; open?: boolean | undefined; vendorId?: string | undefined; search?: string | undefined; cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: PoSummary[]; nextCursor: string | null }> {
  authorizeAny(ctx, PO_READERS);
  const limit = pageLimit(filter.limit);
  const where: SQL[] = [];
  if (filter.status) where.push(eq(purchaseOrders.status, filter.status));
  if (filter.open) where.push(sql`${purchaseOrders.status} <> 'CLOSED'`);
  if (filter.vendorId) where.push(eq(purchaseOrders.vendorId, filter.vendorId));
  if (filter.search) where.push(ilike(purchaseOrders.number, likePattern(filter.search)));
  if (filter.cursor) where.push(lt(purchaseOrders.id, filter.cursor)); // newest first
  const rows = await getDb()
    .select({
      po: purchaseOrders, vendorCode: vendors.code, vendorName: vendors.name,
      lineCount: sql<number>`(select count(*)::int from ${purchaseOrderLines} where ${purchaseOrderLines.purchaseOrderId} = ${purchaseOrders.id})`,
      orderValue: sql<string>`(select coalesce(sum(${purchaseOrderLines.orderedPacks} * ${purchaseOrderLines.expectedUnitCost}), 0)::numeric(14,2) from ${purchaseOrderLines} where ${purchaseOrderLines.purchaseOrderId} = ${purchaseOrders.id})`,
    })
    .from(purchaseOrders).innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .where(and(...where)).orderBy(desc(purchaseOrders.id)).limit(limit + 1);
  const page = rows.slice(0, limit).map((r) => summary(r));
  return { items: page, nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}

function summary(r: { po: typeof purchaseOrders.$inferSelect; vendorCode: string; vendorName: string; lineCount: number; orderValue: string }): PoSummary {
  return {
    id: r.po.id as PurchaseOrderId, number: r.po.number, status: r.po.status, closeReason: r.po.closeReason,
    vendor: { id: r.po.vendorId as VendorId, code: r.vendorCode, name: r.vendorName },
    expectedArrival: r.po.expectedArrival, origin: r.po.origin, lineCount: r.lineCount, orderValue: money(r.orderValue),
    createdAt: r.po.createdAt, version: r.po.version,
  };
}

export async function getPurchaseOrder(ctx: Ctx, id: string): Promise<PoDetail> {
  authorizeAny(ctx, PO_READERS);
  return loadPurchaseOrder(getDb(), id);
}

export async function loadPurchaseOrder(db: Executor, id: string): Promise<PoDetail> {
  const [head] = await db
    .select({
      po: purchaseOrders, vendorCode: vendors.code, vendorName: vendors.name,
      lineCount: sql<number>`(select count(*)::int from ${purchaseOrderLines} where ${purchaseOrderLines.purchaseOrderId} = ${purchaseOrders.id})`,
      orderValue: sql<string>`(select coalesce(sum(${purchaseOrderLines.orderedPacks} * ${purchaseOrderLines.expectedUnitCost}), 0)::numeric(14,2) from ${purchaseOrderLines} where ${purchaseOrderLines.purchaseOrderId} = ${purchaseOrders.id})`,
    })
    .from(purchaseOrders).innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId)).where(eq(purchaseOrders.id, id));
  if (!head) throw new DomainError('NOT_FOUND', { entity: 'purchase_order', id });
  const [lines, events, receipts] = await Promise.all([
    db.select({
      line: purchaseOrderLines, sku: skus, productEn: products.nameEn, productAr: products.nameAr, productTypeId: products.productTypeId,
      shelfLifeMonths: products.shelfLifeMonths, varietyEn: varieties.nameEn, varietyAr: varieties.nameAr, countUnit: productTypes.countUnit, received: receivedPacks,
    })
      .from(purchaseOrderLines).innerJoin(skus, eq(skus.id, purchaseOrderLines.skuId))
      .innerJoin(products, eq(products.id, skus.productId)).innerJoin(productTypes, eq(productTypes.id, products.productTypeId))
      .leftJoin(varieties, eq(varieties.id, skus.varietyId))
      .where(eq(purchaseOrderLines.purchaseOrderId, id)).orderBy(asc(skus.code)),
    db.select({ e: purchaseOrderEvents, actor: users.name }).from(purchaseOrderEvents).innerJoin(users, eq(users.id, purchaseOrderEvents.actorId))
      .where(eq(purchaseOrderEvents.purchaseOrderId, id)).orderBy(asc(purchaseOrderEvents.occurredAt), asc(purchaseOrderEvents.id)),
    db.select({
      r: goodsReceipts, by: users.name,
      packs: sql<number>`(select coalesce(sum(${goodsReceiptLines.packs}), 0)::int from ${goodsReceiptLines} where ${goodsReceiptLines.goodsReceiptId} = ${goodsReceipts.id})`,
    }).from(goodsReceipts).innerJoin(users, eq(users.id, goodsReceipts.createdBy))
      .where(eq(goodsReceipts.purchaseOrderId, id)).orderBy(asc(goodsReceipts.receivedAt)),
  ]);
  const status = head.po.status;
  const typeIds = [...new Set(lines.map((l) => l.productTypeId))];
  const attributes = typeIds.length ? await db.select().from(productTypeAttributes).where(inArray(productTypeAttributes.productTypeId, typeIds)) : [];
  const templateOf = (typeId: string) => templateFrom(attributes.filter((a) => a.productTypeId === typeId));
  return {
    ...summary(head), closeNote: head.po.closeNote, notes: head.po.notes, warehouseId: head.po.warehouseId,
    lines: lines.map((l) => ({
      id: l.line.id, skuId: l.sku.id as SkuId, code: l.sku.code, size: sizeOf(l.sku), countUnit: l.countUnit,
      product: { nameEn: l.productEn, nameAr: l.productAr },
      variety: l.varietyEn !== null && l.varietyAr !== null ? { nameEn: l.varietyEn, nameAr: l.varietyAr } : null,
      orderedPacks: l.line.orderedPacks, expectedUnitCost: money(l.line.expectedUnitCost), receivedPacks: l.received,
      variance: l.received - l.line.orderedPacks, outstandingPacks: outstandingPacks(status, l.line.orderedPacks, l.received),
      receiving: {
        lotNumber: templateOf(l.productTypeId).LOT_NUMBER, manufacturedOn: templateOf(l.productTypeId).MANUFACTURING_DATE,
        expiry: templateOf(l.productTypeId).EXPIRY, shelfLifeMonths: l.shelfLifeMonths,
      },
    })),
    events: events.map(({ e, actor }) => ({ action: e.action, from: e.fromStatus, to: e.toStatus, reason: e.reason, actor, at: e.occurredAt })),
    receipts: receipts.map(({ r, by, packs }) => ({ id: r.id, receivedAt: r.receivedAt, source: r.source, fileName: r.fileName, packs, by })),
  };
}

// ---------------------------------------------------------------- commands

type LineInput = { skuId: string; orderedPacks: number; expectedUnitCost: string };

async function checkLines(db: Executor, lines: readonly LineInput[]) {
  if (lines.length === 0) throw new DomainError('INVALID_PACK_COUNT', { field: 'lines' });
  const ids = [...new Set(lines.map((l) => l.skuId))];
  if (ids.length !== lines.length) throw new DomainError('DUPLICATE_SKU', { field: 'lines' });
  const found = await db.select({ id: skus.id, isActive: skus.isActive }).from(skus).where(inArray(skus.id, ids));
  for (const id of ids) {
    const sku = found.find((s) => s.id === id);
    if (!sku) throw new DomainError('NOT_FOUND', { entity: 'sku', id });
    if (!sku.isActive) throw new DomainError('REFERENCE_INACTIVE', { entity: 'sku', id });
  }
  return lines.map((l) => {
    if (!Number.isSafeInteger(l.orderedPacks) || l.orderedPacks <= 0) throw new DomainError('INVALID_PACK_COUNT', { value: l.orderedPacks });
    const cost = money(l.expectedUnitCost);
    if (dec(cost).isNegative()) throw new DomainError('INVALID_MONEY', { value: cost });
    return { skuId: l.skuId, orderedPacks: l.orderedPacks, expectedUnitCost: cost };
  });
}

async function checkVendor(db: Executor, vendorId: string) {
  const [vendor] = await db.select({ isActive: vendors.isActive }).from(vendors).where(eq(vendors.id, vendorId));
  if (!vendor) throw new DomainError('NOT_FOUND', { entity: 'vendor', id: vendorId });
  if (!vendor.isActive) throw new DomainError('REFERENCE_INACTIVE', { entity: 'vendor', id: vendorId });
}

async function nextNumber(db: Executor, year: number): Promise<string> {
  const key = `PO-${year}`;
  const [row] = await db.insert(documentSequences).values({ key, value: 1 })
    .onConflictDoUpdate({ target: documentSequences.key, set: { value: sql`${documentSequences.value} + 1` } })
    .returning({ value: documentSequences.value });
  return poNumber(year, row?.value ?? 1);
}

async function recordEvent(db: Executor, ctx: Ctx, poId: string, action: string, from: PoStatus | null, to: PoStatus, reason: string | null) {
  await db.insert(purchaseOrderEvents).values({ purchaseOrderId: poId, action, fromStatus: from, toStatus: to, reason, actorId: ctx.user.id, occurredAt: ctx.now });
}

/**
 * PO-002/003: a draft with vendor, lines, expected unit costs and arrival.
 * PO-008: a draft the forecasting engine proposes is the same draft, marked as
 * such, for a manager to review and adjust before submitting.
 */
export async function createPurchaseOrder(
  ctx: Ctx,
  input: { vendorId: string; expectedArrival?: string | null | undefined; notes?: string | null | undefined; lines: readonly LineInput[]; origin?: 'MANUAL' | 'FORECAST' | undefined },
): Promise<PoDetail> {
  authorize(ctx, 'procurement.manage_po');
  return inTx(ctx, async (tx) => {
    await checkVendor(tx, input.vendorId);
    const lines = await checkLines(tx, input.lines);
    const [warehouse] = await tx.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.isActive, true)).orderBy(asc(warehouses.createdAt)).limit(1);
    if (!warehouse) throw new Error('no active warehouse — run pnpm db:sync');
    const number = await nextNumber(tx, Number.parseInt(ctx.now.toISOString().slice(0, 4), 10));
    const [po] = await tx.insert(purchaseOrders).values({
      number, vendorId: input.vendorId, warehouseId: warehouse.id, origin: input.origin ?? 'MANUAL',
      expectedArrival: input.expectedArrival ?? null, notes: input.notes?.trim() || null, branchId: ctx.branchId,
      createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: purchaseOrders.id });
    if (!po) throw new Error('purchase order insert returned nothing');
    await tx.insert(purchaseOrderLines).values(lines.map((l) => ({ purchaseOrderId: po.id, ...l })));
    await recordEvent(tx, ctx, po.id, 'create', null, 'DRAFT', null);
    await audit(tx, ctx, { action: 'procurement.po_created', entityType: 'purchase_order', entityId: po.id, after: { number, vendorId: input.vendorId, lines, origin: input.origin ?? 'MANUAL' } });
    return loadPurchaseOrder(tx, po.id);
  });
}

/** Only a draft is edited; submitted orders change by transition (STATE-MACHINES §1). */
export async function updatePurchaseOrder(
  ctx: Ctx, id: string,
  input: { version: number; vendorId?: string | undefined; expectedArrival?: string | null | undefined; notes?: string | null | undefined; lines?: readonly LineInput[] | undefined },
): Promise<PoDetail> {
  authorize(ctx, 'procurement.manage_po');
  return inTx(ctx, async (tx) => {
    const current = await loadPurchaseOrder(tx, id);
    if (!isEditable(current.status)) throw new DomainError('PO_NOT_EDITABLE', { status: current.status });
    if (input.vendorId && input.vendorId !== current.vendor.id) await checkVendor(tx, input.vendorId);
    const lines = input.lines ? await checkLines(tx, input.lines) : null;
    const [row] = await tx.update(purchaseOrders).set({
      vendorId: input.vendorId ?? current.vendor.id,
      expectedArrival: input.expectedArrival === undefined ? current.expectedArrival : input.expectedArrival,
      notes: input.notes === undefined ? current.notes : (input.notes?.trim() || null),
      updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1,
    }).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.version, input.version))).returning({ id: purchaseOrders.id });
    if (!row) throw new DomainError('VERSION_CONFLICT', { entity: 'purchase_order', id });
    if (lines) {
      await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id));
      await tx.insert(purchaseOrderLines).values(lines.map((l) => ({ purchaseOrderId: id, ...l })));
    }
    await audit(tx, ctx, {
      action: 'procurement.po_updated', entityType: 'purchase_order', entityId: id,
      before: { vendorId: current.vendor.id, expectedArrival: current.expectedArrival, lines: current.lines.map((l) => ({ skuId: l.skuId, orderedPacks: l.orderedPacks, expectedUnitCost: l.expectedUnitCost })) },
      after: { vendorId: input.vendorId ?? current.vendor.id, expectedArrival: input.expectedArrival ?? current.expectedArrival, lines: lines ?? undefined },
    });
    return loadPurchaseOrder(tx, id);
  });
}

/** Every state change (PO-001, 003, 005, 007): the core transition decides; this persists it. */
export async function transitionPurchaseOrder(
  ctx: Ctx, id: string, action: PoAction, input: { version: number; reason?: string | null | undefined },
): Promise<PoDetail> {
  authorizeAny(ctx, ['procurement.manage_po', 'procurement.approve_po']);
  return inTx(ctx, async (tx) => {
    const current = await loadPurchaseOrder(tx, id);
    const reason = input.reason?.trim() || null;
    const next = transitionPo(current.status, action, ctx.permissions, reason);
    const [row] = await tx.update(purchaseOrders).set({
      status: next.to, closeReason: next.closeReason, closeNote: next.to === 'CLOSED' ? reason : current.closeNote,
      updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1,
    }).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.version, input.version))).returning({ id: purchaseOrders.id });
    if (!row) throw new DomainError('VERSION_CONFLICT', { entity: 'purchase_order', id });
    await recordEvent(tx, ctx, id, action, current.status, next.to, reason);
    await audit(tx, ctx, {
      action: `procurement.po_${action}`, entityType: 'purchase_order', entityId: id,
      before: { status: current.status }, after: { status: next.to, closeReason: next.closeReason, reason },
    });
    return loadPurchaseOrder(tx, id);
  });
}

export type IncomingLine = {
  readonly poId: PurchaseOrderId; readonly number: string; readonly status: PoStatus; readonly vendorCode: string;
  readonly expectedArrival: string | null; readonly skuId: SkuId; readonly code: string; readonly product: Named; readonly variety: Named | null;
  readonly size: PackSize; readonly countUnit: CountUnit; readonly outstandingPacks: number;
};

/**
 * PO-004, STK-007: what is on its way, line by line, with the expected
 * arrival for a countdown — never counted as stock. A cancelled or closed
 * order is not here (PO-006).
 */
export async function listIncoming(ctx: Ctx): Promise<IncomingLine[]> {
  authorizeAny(ctx, ['procurement.view', 'procurement.manage_po', 'procurement.approve_po', 'inventory.view_all_stock', 'inventory.receive_goods']);
  const rows = await getDb()
    .select({
      po: purchaseOrders, vendorCode: vendors.code, line: purchaseOrderLines, sku: skus, productEn: products.nameEn, productAr: products.nameAr,
      varietyEn: varieties.nameEn, varietyAr: varieties.nameAr, countUnit: productTypes.countUnit, received: receivedPacks,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .innerJoin(skus, eq(skus.id, purchaseOrderLines.skuId))
    .innerJoin(products, eq(products.id, skus.productId))
    .innerJoin(productTypes, eq(productTypes.id, products.productTypeId))
    .leftJoin(varieties, eq(varieties.id, skus.varietyId))
    .where(inArray(purchaseOrders.status, ['PLACED', 'CONFIRMED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED']))
    .orderBy(sql`${purchaseOrders.expectedArrival} asc nulls last`, asc(purchaseOrders.number), asc(skus.code));
  return rows
    .map((r) => ({
      poId: r.po.id as PurchaseOrderId, number: r.po.number, status: r.po.status, vendorCode: r.vendorCode, expectedArrival: r.po.expectedArrival,
      skuId: r.sku.id as SkuId, code: r.sku.code, size: sizeOf(r.sku), countUnit: r.countUnit,
      product: { nameEn: r.productEn, nameAr: r.productAr },
      variety: r.varietyEn !== null && r.varietyAr !== null ? { nameEn: r.varietyEn, nameAr: r.varietyAr } : null,
      outstandingPacks: outstandingPacks(r.po.status, r.line.orderedPacks, r.received),
    }))
    .filter((l) => l.outstandingPacks > 0);
}
