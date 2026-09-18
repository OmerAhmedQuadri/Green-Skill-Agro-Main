import { sql } from 'drizzle-orm';
import { check, date, index, integer, numeric, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { skus } from './catalogue';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { mutable } from './mutable';
import { branches, warehouses } from './organisation';
import { batches } from './stock';
import { vendors } from './vendors';

// Mirror packages/core/src/procurement/transitions.ts.
export const poStatus = pgEnum('po_status', [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PLACED', 'CONFIRMED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED',
]);
export const poCloseReason = pgEnum('po_close_reason', ['COMPLETE', 'SHORT', 'CANCELLED']);
export const poOrigin = pgEnum('po_origin', ['MANUAL', 'FORECAST']); // PO-008
export const receiptSource = pgEnum('receipt_source', ['MANUAL', 'IMPORT']);

/** PO-001..008. Status changes only through the core transition (STATE-MACHINES §1). */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: id(),
    number: text('number').notNull().unique(),
    vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
    warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
    status: poStatus('status').notNull().default('DRAFT'),
    closeReason: poCloseReason('close_reason'),
    closeNote: text('close_note'),
    origin: poOrigin('origin').notNull().default('MANUAL'),
    expectedArrival: date('expected_arrival'),
    notes: text('notes'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    index('purchase_orders_vendor_id_idx').on(t.vendorId),
    index('purchase_orders_status_idx').on(t.status),
    index('purchase_orders_warehouse_id_idx').on(t.warehouseId),
    check('purchase_orders_closed_has_reason', sql`(${t.status} = 'CLOSED') = (${t.closeReason} is not null)`),
  ],
);

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: id(),
    purchaseOrderId: uuid('purchase_order_id').notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id').notNull().references(() => skus.id),
    orderedPacks: integer('ordered_packs').notNull(),
    expectedUnitCost: numeric('expected_unit_cost', { precision: 14, scale: 2 }).notNull(), // per pack, SAR
  },
  (t) => [
    unique('purchase_order_lines_sku_unique').on(t.purchaseOrderId, t.skuId),
    index('purchase_order_lines_sku_id_idx').on(t.skuId),
    check('purchase_order_lines_packs_positive', sql`${t.orderedPacks} > 0`),
    check('purchase_order_lines_cost_non_negative', sql`${t.expectedUnitCost} >= 0`),
  ],
);

/** Every transition, with actor and reason (STATE-MACHINES conventions). Append-only. */
export const purchaseOrderEvents = pgTable(
  'purchase_order_events',
  {
    id: id(),
    purchaseOrderId: uuid('purchase_order_id').notNull().references(() => purchaseOrders.id),
    action: text('action').notNull(),
    fromStatus: poStatus('from_status'),
    toStatus: poStatus('to_status').notNull(),
    reason: text('reason'),
    actorId: uuid('actor_id').notNull().references(() => users.id),
    occurredAt: timestamptz('occurred_at').notNull(),
  },
  (t) => [index('purchase_order_events_po_idx').on(t.purchaseOrderId, t.occurredAt)],
);

/** RCV-001..008. A receipt is a fact: append-only; corrections are later movements. */
export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: id(),
    purchaseOrderId: uuid('purchase_order_id').notNull().references(() => purchaseOrders.id),
    warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
    receivedAt: timestamptz('received_at').notNull(),
    source: receiptSource('source').notNull(),
    fileName: text('file_name'),
    note: text('note'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
  },
  (t) => [index('goods_receipts_po_idx').on(t.purchaseOrderId), index('goods_receipts_warehouse_id_idx').on(t.warehouseId)],
);

export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    id: id(),
    goodsReceiptId: uuid('goods_receipt_id').notNull().references(() => goodsReceipts.id),
    purchaseOrderLineId: uuid('purchase_order_line_id').notNull().references(() => purchaseOrderLines.id),
    batchId: uuid('batch_id').notNull().references(() => batches.id),
    packs: integer('packs').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(), // base units (ADR-0015)
    unitCost: numeric('unit_cost', { precision: 14, scale: 2 }), // per pack, SAR
  },
  (t) => [
    index('goods_receipt_lines_receipt_idx').on(t.goodsReceiptId),
    index('goods_receipt_lines_po_line_idx').on(t.purchaseOrderLineId),
    index('goods_receipt_lines_batch_idx').on(t.batchId),
    check('goods_receipt_lines_packs_positive', sql`${t.packs} > 0`),
  ],
);

/** Human-readable document numbers, e.g. PO-2026-0007. One row per series. */
export const documentSequences = pgTable('document_sequences', {
  key: text('key').primaryKey(),
  value: integer('value').notNull(),
});
