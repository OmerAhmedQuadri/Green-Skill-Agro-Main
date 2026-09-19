import {
  DomainError, heldFromSale, packsHeld, quantity, type CountUnit, type HeldBatch, type Money, type PackSize, type ReturnCondition,
  type ReturnKind, type ReturnOutcome, type SkuUnits,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { aliasedTable, and, asc, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { sizeOf } from '../catalogue';
import { authorizeAny, type Ctx } from '../context';
import { decodeCursor, encodeCursor, inOrder, pageLimit, type Executor } from '../platform';
import { getDb } from '../runtime';

const {
  returns, returnLines, returnReplacements, sales, saleLines, saleLineAllocations, stores, users, vehicles, warehouses,
  skus, products, varieties, productTypes, batches, deliveryDocuments,
} = schema;

type Named = { readonly nameEn: string; readonly nameAr: string };
type Person = { readonly id: string; readonly name: string };
type BatchInfo = { readonly batchId: string; readonly lotNumber: string | null; readonly expiresOn: string | null; readonly packs: number };

export type ReturnLine = {
  readonly id: string; readonly saleLineId: string; readonly code: string; readonly product: Named; readonly variety: Named | null;
  readonly size: PackSize; readonly countUnit: CountUnit; readonly packs: number; readonly outcome: ReturnOutcome; readonly amount: Money;
  /** RET-007: the original batch, lot and expiry kept. */ readonly batch: Omit<BatchInfo, 'packs'>;
  /** RET-010: what was handed over instead, from the vehicle. */ readonly replacements: readonly BatchInfo[];
};

export type ReturnRecord = {
  readonly id: string; readonly number: string; readonly kind: ReturnKind; readonly condition: ReturnCondition;
  readonly sale: { readonly id: string; readonly documentNumber: string | null; readonly total: Money };
  readonly store: { readonly id: string; readonly name: string };
  /** RET-009: the sale's seller, whose sales it reduces. */ readonly seller: Person;
  readonly processedBy: Person;
  readonly vehicle: { readonly id: string; readonly registration: string } | null;
  readonly warehouse: { readonly id: string; readonly name: Named } | null;
  /** RET-008, OQ-020: the credit, and where it went. */
  readonly amount: Money; readonly toSale: Money; readonly toOtherDebts: Money; readonly refund: Money;
  /** COM-009: the part already collected — commission in M11. */ readonly collectedPortion: Money;
  readonly note: string | null; readonly occurredAt: Date;
  readonly lines: readonly ReturnLine[];
};

export type ReturnSummary = Pick<ReturnRecord, 'id' | 'number' | 'kind' | 'condition' | 'store' | 'seller' | 'amount' | 'refund' | 'occurredAt'> & {
  readonly saleId: string; readonly packs: number;
};

/** PERMISSIONS §3.1: a seller sees the returns on their sales; whoever recorded one sees it; `sales.view_all` sees all. */
function visibility(ctx: Ctx): SQL | undefined {
  if (ctx.permissions.has('sales.view_all')) return undefined;
  return or(eq(returns.sellerId, ctx.user.id), eq(returns.processedBy, ctx.user.id));
}

const seller = aliasedTable(users, 'seller');
const processor = aliasedTable(users, 'processor');
const replacementBatch = aliasedTable(batches, 'replacement_batch');

/** One return, if the caller may see it — otherwise it does not exist for them (SECURITY §3). */
export async function loadReturn(db: Executor, ctx: Ctx, id: string): Promise<ReturnRecord> {
  const [row] = await db.select({
    r: returns, storeName: stores.name, sellerName: seller.name, processorName: processor.name, saleTotal: sales.total,
    documentNumber: deliveryDocuments.number, registration: vehicles.registration, warehouseEn: warehouses.nameEn, warehouseAr: warehouses.nameAr,
  }).from(returns)
    .innerJoin(sales, eq(sales.id, returns.saleId)).innerJoin(stores, eq(stores.id, returns.storeId))
    .leftJoin(seller, eq(seller.id, returns.sellerId)).leftJoin(processor, eq(processor.id, returns.processedBy))
    .leftJoin(deliveryDocuments, eq(deliveryDocuments.saleId, returns.saleId))
    .leftJoin(vehicles, eq(vehicles.id, returns.vehicleId)).leftJoin(warehouses, eq(warehouses.id, returns.warehouseId))
    .where(and(eq(returns.id, id), visibility(ctx)));
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'return', id });
  const r = row.r;
  const [lineRows, replacementRows] = await inOrder([
    db.select({
      l: returnLines, sku: skus, productEn: products.nameEn, productAr: products.nameAr, varietyEn: varieties.nameEn, varietyAr: varieties.nameAr,
      countUnit: productTypes.countUnit, lotNumber: batches.lotNumber, expiresOn: batches.expiresOn,
    }).from(returnLines)
      .innerJoin(saleLines, eq(saleLines.id, returnLines.saleLineId)).innerJoin(skus, eq(skus.id, saleLines.skuId))
      .innerJoin(products, eq(products.id, skus.productId)).innerJoin(productTypes, eq(productTypes.id, products.productTypeId))
      .leftJoin(varieties, eq(varieties.id, skus.varietyId)).innerJoin(batches, eq(batches.id, returnLines.batchId))
      .where(eq(returnLines.returnId, id)).orderBy(asc(skus.code), asc(returnLines.id)),
    db.select({ x: returnReplacements, lotNumber: replacementBatch.lotNumber, expiresOn: replacementBatch.expiresOn })
      .from(returnReplacements).innerJoin(returnLines, eq(returnLines.id, returnReplacements.returnLineId))
      .innerJoin(replacementBatch, eq(replacementBatch.id, returnReplacements.batchId))
      .where(eq(returnLines.returnId, id)).orderBy(sql`${replacementBatch.expiresOn} asc nulls last`),
  ]);
  return {
    id: r.id, number: r.number, kind: r.kind, condition: r.condition,
    sale: { id: r.saleId, documentNumber: row.documentNumber, total: row.saleTotal as Money },
    store: { id: r.storeId, name: row.storeName },
    seller: { id: r.sellerId, name: row.sellerName ?? '' }, processedBy: { id: r.processedBy, name: row.processorName ?? '' },
    vehicle: r.vehicleId && row.registration ? { id: r.vehicleId, registration: row.registration } : null,
    warehouse: r.warehouseId && row.warehouseEn !== null && row.warehouseAr !== null ? { id: r.warehouseId, name: { nameEn: row.warehouseEn, nameAr: row.warehouseAr } } : null,
    amount: r.amount as Money, toSale: r.toSale as Money, toOtherDebts: r.toOtherDebts as Money, refund: r.refund as Money,
    collectedPortion: r.collectedPortion as Money, note: r.note, occurredAt: r.occurredAt,
    lines: lineRows.map((x) => ({
      id: x.l.id, saleLineId: x.l.saleLineId, code: x.sku.code,
      product: { nameEn: x.productEn, nameAr: x.productAr },
      variety: x.varietyEn !== null && x.varietyAr !== null ? { nameEn: x.varietyEn, nameAr: x.varietyAr } : null,
      size: sizeOf(x.sku), countUnit: x.countUnit, packs: x.l.packs, outcome: x.l.outcome, amount: x.l.amount as Money,
      batch: { batchId: x.l.batchId, lotNumber: x.lotNumber, expiresOn: x.expiresOn },
      replacements: replacementRows.filter((p) => p.x.returnLineId === x.l.id)
        .map((p) => ({ batchId: p.x.batchId, lotNumber: p.lotNumber, expiresOn: p.expiresOn, packs: p.x.packs })),
    })),
  };
}

/** Who may read returns at all; `visibility` then narrows it to the ones they may see. */
export const RETURN_READERS = ['sales.record', 'sales.view_all', 'returns.process'] as const;

/** A return the caller may see. */
export async function getReturn(ctx: Ctx, id: string): Promise<ReturnRecord> {
  authorizeAny(ctx, RETURN_READERS);
  return loadReturn(ctx.tx ?? getDb(), ctx, id);
}

export type ReturnFilter = {
  readonly saleId?: string | undefined; readonly storeId?: string | undefined; readonly sellerId?: string | undefined;
  readonly cursor?: string | undefined; readonly limit?: number | undefined;
};

/** Newest first: the returns on a seller's sales, or — with `sales.view_all` — everyone's. */
export async function queryReturns(db: Executor, ctx: Ctx, filter: ReturnFilter): Promise<{ items: ReturnSummary[]; nextCursor: string | null }> {
  const limit = pageLimit(filter.limit);
  const where: (SQL | undefined)[] = [visibility(ctx)];
  if (filter.saleId) where.push(eq(returns.saleId, filter.saleId));
  if (filter.storeId) where.push(eq(returns.storeId, filter.storeId));
  if (filter.sellerId) where.push(eq(returns.sellerId, filter.sellerId));
  if (filter.cursor) {
    const [at, id] = decodeCursor(filter.cursor, 2) as [string, string];
    where.push(or(lt(returns.occurredAt, new Date(at)), and(eq(returns.occurredAt, new Date(at)), lt(returns.id, id))));
  }
  const packs = sql<number>`(select coalesce(sum(${returnLines.packs}), 0)::int from ${returnLines} where ${returnLines.returnId} = ${returns.id})`;
  const rows = await db.select({ r: returns, storeName: stores.name, sellerName: seller.name, packs })
    .from(returns).innerJoin(stores, eq(stores.id, returns.storeId)).innerJoin(seller, eq(seller.id, returns.sellerId))
    .where(and(...where)).orderBy(desc(returns.occurredAt), desc(returns.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((x) => ({
      id: x.r.id, number: x.r.number, kind: x.r.kind, condition: x.r.condition, saleId: x.r.saleId,
      store: { id: x.r.storeId, name: x.storeName }, seller: { id: x.r.sellerId, name: x.sellerName },
      amount: x.r.amount as Money, refund: x.r.refund as Money, occurredAt: x.r.occurredAt, packs: Number(x.packs),
    })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.r.occurredAt.toISOString(), last.r.id]) : null,
  };
}

export async function listReturns(ctx: Ctx, filter: ReturnFilter): Promise<{ items: ReturnSummary[]; nextCursor: string | null }> {
  authorizeAny(ctx, RETURN_READERS);
  return queryReturns(ctx.tx ?? getDb(), ctx, filter);
}

/**
 * ADR-0039: what a store still holds from a sale, per line and batch — sold,
 * less what came back, plus replacements — and the packs already credited on
 * each line, which price the next credit note.
 */
export async function heldFromSaleOf(db: Executor, saleId: string, units: ReadonlyMap<string, SkuUnits>): Promise<{ held: HeldBatch[]; credited: Map<string, number> }> {
  const [soldRows, returnedRows, replacedRows] = await inOrder([
    db.select({ saleLineId: saleLineAllocations.saleLineId, batchId: saleLineAllocations.batchId, quantity: saleLineAllocations.quantity })
      .from(saleLineAllocations).innerJoin(saleLines, eq(saleLines.id, saleLineAllocations.saleLineId)).where(eq(saleLines.saleId, saleId)),
    db.select({ saleLineId: returnLines.saleLineId, batchId: returnLines.batchId, packs: returnLines.packs, kind: returns.kind })
      .from(returnLines).innerJoin(returns, eq(returns.id, returnLines.returnId)).where(eq(returns.saleId, saleId)),
    db.select({ saleLineId: returnLines.saleLineId, batchId: returnReplacements.batchId, packs: returnReplacements.packs })
      .from(returnReplacements).innerJoin(returnLines, eq(returnLines.id, returnReplacements.returnLineId))
      .innerJoin(returns, eq(returns.id, returnLines.returnId)).where(eq(returns.saleId, saleId)),
  ]);
  const sold = soldRows.map((r) => {
    const u = units.get(r.saleLineId);
    if (!u) throw new Error('sale line units missing');
    return { saleLineId: r.saleLineId, batchId: r.batchId, packs: packsHeld(quantity(r.quantity), u) };
  });
  const credited = new Map<string, number>();
  for (const r of returnedRows) if (r.kind === 'CREDIT_NOTE') credited.set(r.saleLineId, (credited.get(r.saleLineId) ?? 0) + r.packs);
  return { held: heldFromSale(sold, returnedRows, replacedRows), credited };
}

/** Batch details for the returnable view, soonest expiry first. */
export async function batchInfo(db: Executor, ids: readonly string[]): Promise<Map<string, { lotNumber: string | null; expiresOn: string | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: batches.id, lotNumber: batches.lotNumber, expiresOn: batches.expiresOn }).from(batches)
    .where(inArray(batches.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, { lotNumber: r.lotNumber, expiresOn: r.expiresOn }]));
}

