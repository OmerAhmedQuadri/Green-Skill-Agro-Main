import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, numeric, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { mediaAssets } from './media';
import { mutable } from './mutable';
import { branches, warehouses } from './organisation';
import { returns } from './returns';
import { batches, stockAccountKind } from './stock';
import { vehicles } from './vehicles';

// Mirror packages/core/src/inventory/write-offs.ts.
export const writeOffStatus = pgEnum('write_off_status', ['SUBMITTED', 'APPROVED', 'REJECTED']);
export const writeOffReason = pgEnum('write_off_reason', ['DAMAGED', 'EXPIRED', 'SPOILED', 'MISSING', 'CONVERSION_LOSS', 'DEFECTIVE', 'OTHER']);

/**
 * CNV-001..011: a record of every conversion — who, when, why (CNV-007) —
 * beside its three-legged ledger group. No approval step (CNV-008). Append-only.
 */
export const skuConversions = pgTable(
  'sku_conversions',
  {
    id: id(),
    sourceBatchId: uuid('source_batch_id').notNull().references(() => batches.id),
    targetBatchId: uuid('target_batch_id').notNull().references(() => batches.id),
    accountKind: stockAccountKind('account_kind').notNull(),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),
    sourcePacks: integer('source_packs').notNull(),
    targetPacks: integer('target_packs').notNull(),
    sourceQuantity: numeric('source_quantity', { precision: 14, scale: 3 }).notNull(),
    targetQuantity: numeric('target_quantity', { precision: 14, scale: 3 }).notNull(),
    lossQuantity: numeric('loss_quantity', { precision: 14, scale: 3 }).notNull(),
    reason: text('reason').notNull(),
    movementGroupId: uuid('movement_group_id').notNull(),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    performedAt: timestamptz('performed_at').notNull(),
    performedBy: uuid('performed_by').notNull().references(() => users.id),
  },
  (t) => [
    index('sku_conversions_source_batch_idx').on(t.sourceBatchId),
    index('sku_conversions_target_batch_idx').on(t.targetBatchId),
    index('sku_conversions_warehouse_id_idx').on(t.warehouseId),
    index('sku_conversions_performed_at_idx').on(t.performedAt),
    check('sku_conversions_balanced', sql`${t.sourceQuantity} = ${t.targetQuantity} + ${t.lossQuantity}`),
  ],
);

/**
 * WRO-001..007, STATE-MACHINES §5. Nothing moves until approval; a
 * conversion loss or a defective unit arrives already approved. Attributed
 * to the holding location (WRO-005), never charged.
 */
export const writeOffs = pgTable(
  'write_offs',
  {
    id: id(),
    number: text('number').notNull().unique(),
    status: writeOffStatus('status').notNull(),
    reason: writeOffReason('reason').notNull(),
    note: text('note'),
    batchId: uuid('batch_id').notNull().references(() => batches.id),
    accountKind: stockAccountKind('account_kind').notNull(),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),
    requestedPacks: integer('requested_packs'), // null for a conversion loss, which may be part of a pack
    requestedQuantity: numeric('requested_quantity', { precision: 14, scale: 3 }).notNull(),
    approvedQuantity: numeric('approved_quantity', { precision: 14, scale: 3 }),
    photoId: uuid('photo_id').references(() => mediaAssets.id),
    conversionId: uuid('conversion_id').references(() => skuConversions.id),
    returnId: uuid('return_id').references(() => returns.id), // ADR-0039: a defective or unsaleable return
    auditId: uuid('audit_id'), // VEH-013: a shortfall a vehicle audit found (ADR-0041)
    movementGroupId: uuid('movement_group_id'),
    submittedAt: timestamptz('submitted_at').notNull(),
    submittedBy: uuid('submitted_by').notNull().references(() => users.id),
    decidedAt: timestamptz('decided_at'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decisionComment: text('decision_comment'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    index('write_offs_status_idx').on(t.status),
    index('write_offs_batch_id_idx').on(t.batchId),
    index('write_offs_warehouse_id_idx').on(t.warehouseId),
    index('write_offs_vehicle_id_idx').on(t.vehicleId),
    index('write_offs_photo_id_idx').on(t.photoId),
    index('write_offs_conversion_id_idx').on(t.conversionId),
    index('write_offs_return_id_idx').on(t.returnId),
    index('write_offs_audit_id_idx').on(t.auditId),
    index('write_offs_submitted_by_idx').on(t.submittedBy),
    check('write_offs_quantity_positive', sql`${t.requestedQuantity} > 0`),
    check('write_offs_decided', sql`(${t.status} = 'SUBMITTED') = (${t.decidedAt} is null)`),
  ],
);

/** EXP-006, `inventory.manage_expiry`: a batch a manager has put first in line for clearance. */
export const stockFlags = pgTable('stock_flags', {
  batchId: uuid('batch_id').primaryKey().references(() => batches.id),
  prioritised: boolean('prioritised').notNull().default(false),
  note: text('note'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id),
  createdAt: createdAt(),
});
