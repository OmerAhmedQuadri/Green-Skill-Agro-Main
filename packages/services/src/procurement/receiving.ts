import {
  checkReceiptLine, DomainError, isDomainError, packCount, resolveReceiptLine, RECEIVABLE, statusAfterReceipt, templateFrom, toBaseUnits, transfer,
  type ErrorCode, type Leg, type PoStatus, type ReceiptLineInput, type ReceivingSku, type SkuUnits,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { readSheet } from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { authorize, type Ctx } from '../context';
import { findOrCreateBatch, postStockMovements } from '../inventory';
import { audit, inTx, type Executor } from '../platform';
import { getDb } from '../runtime';
import { loadPurchaseOrder, type PoDetail } from './purchase-orders';

const { purchaseOrders, purchaseOrderLines, purchaseOrderEvents, goodsReceipts, goodsReceiptLines, skus, products, productTypeAttributes } = schema;

export type ReceiveLine = ReceiptLineInput & { readonly purchaseOrderLineId: string };

type OrderLine = ReceivingSku & { readonly lineId: string; readonly units: SkuUnits; readonly ordered: number };

/** The order's lines with what receiving them needs: template, default shelf life, pack size. */
async function orderLines(db: Executor, poId: string): Promise<OrderLine[]> {
  const rows = await db.select({ line: purchaseOrderLines, sku: skus, shelfLifeMonths: products.shelfLifeMonths, productTypeId: products.productTypeId })
    .from(purchaseOrderLines).innerJoin(skus, eq(skus.id, purchaseOrderLines.skuId)).innerJoin(products, eq(products.id, skus.productId))
    .where(eq(purchaseOrderLines.purchaseOrderId, poId));
  const typeIds = [...new Set(rows.map((r) => r.productTypeId))];
  const attributes = typeIds.length ? await db.select().from(productTypeAttributes).where(inArray(productTypeAttributes.productTypeId, typeIds)) : [];
  return rows.map((r) => ({
    lineId: r.line.id, skuId: r.sku.id, code: r.sku.code, ordered: r.line.orderedPacks, shelfLifeMonths: r.shelfLifeMonths,
    template: templateFrom(attributes.filter((a) => a.productTypeId === r.productTypeId)),
    units: r.sku.measure === 'WEIGHT' ? { measure: 'WEIGHT', packWeightG: r.sku.packWeightG ?? '0' } : { measure: 'COUNT', packCount: r.sku.packCount ?? 0 },
  }));
}

/** A domain error from line n, so the form can point at it. */
function onLine<T>(index: number, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (isDomainError(e)) throw new DomainError(e.code, { ...e.details, line: index });
    throw e;
  }
}

/**
 * Workflow C step 5 (RCV-003..008): record what arrived. Each line becomes
 * stock in a batch — SKU + LOT + MFD + expiry — posted +WAREHOUSE / −SUPPLIER.
 * One order line may arrive as several batches (RCV-004). The order moves to
 * part- or fully received, with the variance per line kept (RCV-007); a full
 * receipt closes it complete (workflow C step 6).
 */
export async function receiveGoods(
  ctx: Ctx, poId: string,
  input: {
    version: number; lines: readonly ReceiveLine[]; receivedAt?: Date | undefined; note?: string | null | undefined;
    source?: 'MANUAL' | 'IMPORT' | undefined; fileName?: string | null | undefined;
  },
): Promise<PoDetail> {
  const source = input.source ?? 'MANUAL';
  authorize(ctx, source === 'IMPORT' ? 'inventory.bulk_import' : 'inventory.receive_goods');
  if (input.lines.length === 0) throw new DomainError('INVALID_PACK_COUNT', { field: 'lines' });
  const receivedAt = input.receivedAt ?? ctx.now;

  return inTx(ctx, async (tx) => {
    // One receipt at a time per order: the row lock serialises them.
    const [locked] = await tx.select({ status: purchaseOrders.status, version: purchaseOrders.version, warehouseId: purchaseOrders.warehouseId })
      .from(purchaseOrders).where(eq(purchaseOrders.id, poId)).for('update');
    if (!locked) throw new DomainError('NOT_FOUND', { entity: 'purchase_order', id: poId });
    if (locked.version !== input.version) throw new DomainError('VERSION_CONFLICT', { entity: 'purchase_order', id: poId });
    if (!RECEIVABLE.includes(locked.status)) throw new DomainError('PO_NOT_RECEIVABLE', { status: locked.status });

    const lines = await orderLines(tx, poId);
    const resolved = input.lines.map((l, i) => onLine(i, () => {
      const orderLine = lines.find((o) => o.lineId === l.purchaseOrderLineId);
      if (!orderLine) throw new DomainError('SKU_NOT_ON_ORDER', { purchaseOrderLineId: l.purchaseOrderLineId });
      return { orderLine, line: resolveReceiptLine(orderLine, l) };
    }));

    const [receipt] = await tx.insert(goodsReceipts).values({
      purchaseOrderId: poId, warehouseId: locked.warehouseId, receivedAt, source, fileName: input.fileName?.trim() || null,
      note: input.note?.trim() || null, branchId: ctx.branchId, createdBy: ctx.user.id,
    }).returning({ id: goodsReceipts.id });
    if (!receipt) throw new Error('goods receipt insert returned nothing');

    const legs: Leg[] = [];
    for (const { orderLine, line } of resolved) {
      const batch = await findOrCreateBatch(tx, ctx, { skuId: line.skuId, lotNumber: line.lotNumber, manufacturedOn: line.manufacturedOn, expiresOn: line.expiresOn, receivedAt });
      // ADR-0015: packs in, base units stored.
      const quantity = toBaseUnits(packCount(line.packs), orderLine.units);
      legs.push(...transfer(batch, quantity, { kind: 'SUPPLIER' }, { kind: 'WAREHOUSE', warehouseId: locked.warehouseId }));
      await tx.insert(goodsReceiptLines).values({
        goodsReceiptId: receipt.id, purchaseOrderLineId: orderLine.lineId, batchId: batch.id, packs: line.packs, quantity, unitCost: line.unitCost,
      });
    }
    await postStockMovements(tx, ctx, { referenceType: 'GOODS_RECEIPT', referenceId: receipt.id, occurredAt: receivedAt, legs });

    // RCV-007: the order's state follows what has now arrived in total.
    const totals = await tx.select({ lineId: goodsReceiptLines.purchaseOrderLineId, packs: sql<number>`sum(${goodsReceiptLines.packs})::int` })
      .from(goodsReceiptLines).innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptLines.goodsReceiptId))
      .where(eq(goodsReceipts.purchaseOrderId, poId)).groupBy(goodsReceiptLines.purchaseOrderLineId);
    const after = statusAfterReceipt(lines.map((l) => ({ ordered: l.ordered, received: totals.find((t) => t.lineId === l.lineId)?.packs ?? 0 })));
    const final: PoStatus = after === 'FULLY_RECEIVED' ? 'CLOSED' : after;
    await tx.update(purchaseOrders).set({
      status: final, closeReason: final === 'CLOSED' ? 'COMPLETE' : null,
      updatedAt: ctx.now, updatedBy: ctx.user.id, version: locked.version + 1,
    }).where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.version, locked.version)));
    await tx.insert(purchaseOrderEvents).values({ purchaseOrderId: poId, action: 'receive', fromStatus: locked.status, toStatus: after, reason: null, actorId: ctx.user.id, occurredAt: ctx.now });
    if (final === 'CLOSED') {
      await tx.insert(purchaseOrderEvents).values({ purchaseOrderId: poId, action: 'close_complete', fromStatus: after, toStatus: 'CLOSED', reason: null, actorId: ctx.user.id, occurredAt: ctx.now });
    }
    await audit(tx, ctx, {
      action: 'inventory.goods_received', entityType: 'goods_receipt', entityId: receipt.id,
      after: { purchaseOrderId: poId, source, fileName: input.fileName ?? null, lines: resolved.map((r) => r.line), status: final },
    });
    return loadPurchaseOrder(tx, poId);
  });
}

// ---------------------------------------------------------------- bulk import (RCV-001, RCV-002)

/** The template's columns, in order. The header row is only a label; columns are read by position. */
export const RECEIPT_COLUMNS = ['sku', 'product', 'packs', 'lotNumber', 'manufacturedOn', 'expiresOn', 'shelfLifeMonths', 'unitCost'] as const;
export type ReceiptColumn = (typeof RECEIPT_COLUMNS)[number];

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export type PreviewRow = {
  /** The spreadsheet row number, as the user sees it. */ readonly row: number;
  readonly code: string;
  readonly input: ReceiveLine | null;
  readonly error: { readonly code: ErrorCode; readonly field: string | null } | null;
};

type Cell = string | number | boolean | Date | null;

const text = (c: Cell): string => {
  if (c === null) return '';
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  if (typeof c === 'number') return String(c);
  return String(c).trim();
};
/** Excel dates arrive as dates; typed text is accepted only as YYYY-MM-DD. */
const dateCell = (c: Cell): string | null => (c === null || c === '' ? null : c instanceof Date ? c.toISOString().slice(0, 10) : text(c));

/**
 * RCV-002: every row validated and previewed with its problem, nothing
 * written. The confirmed rows are then committed with receiveGoods, which
 * checks them again.
 */
export async function previewReceiptImport(
  ctx: Ctx, poId: string, input: { fileName: string; content: string },
): Promise<{ fileName: string; rows: PreviewRow[]; valid: number; invalid: number }> {
  authorize(ctx, 'inventory.bulk_import');
  const bytes = Buffer.from(input.content, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMPORT_BYTES) throw new DomainError('INVALID_IMPORT_FILE', { reason: 'SIZE' });
  let sheet: Cell[][];
  try {
    sheet = (await readSheet(bytes)) as unknown as Cell[][];
  } catch {
    throw new DomainError('INVALID_IMPORT_FILE', { reason: 'UNREADABLE' });
  }
  const db = getDb();
  const po = await loadPurchaseOrder(db, poId);
  if (!RECEIVABLE.includes(po.status)) throw new DomainError('PO_NOT_RECEIVABLE', { status: po.status });
  const lines = await orderLines(db, poId);

  const rows: PreviewRow[] = [];
  sheet.forEach((cells, index) => {
    if (index === 0) return; // the header
    if (cells.every((c) => c === null || c === '')) return;
    const at = (column: ReceiptColumn): Cell => cells[RECEIPT_COLUMNS.indexOf(column)] ?? null;
    const code = text(at('sku')).toUpperCase();
    const orderLine = lines.find((l) => l.code === code);
    if (!orderLine) {
      rows.push({ row: index + 1, code, input: null, error: { code: 'SKU_NOT_ON_ORDER', field: 'sku' } });
      return;
    }
    const packsText = text(at('packs'));
    const months = text(at('shelfLifeMonths'));
    const receiveLine: ReceiveLine = {
      purchaseOrderLineId: orderLine.lineId,
      packs: /^\d+$/.test(packsText) ? Number.parseInt(packsText, 10) : Number.NaN,
      lotNumber: text(at('lotNumber')) || null,
      manufacturedOn: dateCell(at('manufacturedOn')),
      expiresOn: dateCell(at('expiresOn')),
      shelfLife: /^\d+$/.test(months) ? { months: Number.parseInt(months, 10) } : null,
      unitCost: text(at('unitCost')) || null,
    };
    const checked = checkReceiptLine(orderLine, receiveLine);
    rows.push({ row: index + 1, code, input: receiveLine, error: 'error' in checked ? checked.error : null });
  });
  const invalid = rows.filter((r) => r.error).length;
  return { fileName: input.fileName, rows, valid: rows.length - invalid, invalid };
}

/**
 * RCV-001: the template, pre-filled with the order's outstanding lines. The
 * web layer passes the header labels, translated — services build no text.
 */
export async function receiptTemplate(
  ctx: Ctx, poId: string, labels: Readonly<Record<ReceiptColumn, string>>,
): Promise<{ fileName: string; content: Buffer }> {
  authorize(ctx, 'inventory.bulk_import');
  const po = await loadPurchaseOrder(getDb(), poId);
  const defaults = new Map((await orderLines(getDb(), poId)).map((l) => [l.lineId, l.shelfLifeMonths]));
  const header = RECEIPT_COLUMNS.map((c) => ({ value: labels[c], fontWeight: 'bold' as const }));
  const body = po.lines.filter((l) => l.outstandingPacks > 0).map((l) => [
    l.code, ctx.locale === 'ar' ? l.product.nameAr : l.product.nameEn, l.outstandingPacks, null, null, null,
    // Money stays a decimal string, even in a spreadsheet cell (ADR-0003).
    defaults.get(l.id) ?? null, l.expectedUnitCost,
  ]);
  const content = await writeXlsxFile([header, ...body], {
    sheet: po.number, rightToLeft: ctx.locale === 'ar', stickyRowsCount: 1,
    columns: [{ width: 18 }, { width: 28 }, { width: 10 }, { width: 14 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 14 }],
  }).toBuffer();
  return { fileName: `${po.number}-receipt.xlsx`, content };
}
