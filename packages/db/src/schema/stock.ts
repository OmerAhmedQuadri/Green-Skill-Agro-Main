import { sql } from 'drizzle-orm';
import { check, date, index, numeric, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { skus } from './catalogue';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { branches, warehouses } from './organisation';
import { vehicles } from './vehicles';

// Mirror packages/core/src/inventory/postings.ts; a services test keeps them in step.
export const stockAccountKind = pgEnum('stock_account_kind', ['WAREHOUSE', 'VEHICLE', 'DISPATCHED', 'SUPPLIER', 'SOLD', 'WRITTEN_OFF']);
export const stockReferenceType = pgEnum('stock_reference_type', [
  'GOODS_RECEIPT', 'SKU_CONVERSION', 'WRITE_OFF', 'VEHICLE_LOADOUT', 'VEHICLE_RETURN', 'SALE', 'DISPATCH_ORDER',
  'LOST_ORDER_CLAIM', 'RETURN', 'DEFECTIVE_REPLACEMENT', 'VEHICLE_AUDIT', 'OPENING_BALANCE',
]);

/**
 * STK-001/002, DATA-MODEL §5.2: a batch is SKU + LOT + MFD + expiry, never LOT
 * alone. Repeat consignments of the same LOT and dates add to the same batch.
 * Immutable: UPDATE and DELETE are revoked.
 */
export const batches = pgTable(
  'batches',
  {
    id: id(),
    skuId: uuid('sku_id').notNull().references(() => skus.id),
    lotNumber: text('lot_number'),
    manufacturedOn: date('manufactured_on'),
    expiresOn: date('expires_on'), // null: the product type has expiry disabled (CAT-016)
    firstReceivedAt: timestamptz('first_received_at').notNull(),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
  },
  (t) => [
    unique('batches_identity').on(t.skuId, t.lotNumber, t.manufacturedOn, t.expiresOn).nullsNotDistinct(),
    index('batches_lot_number_idx').on(t.lotNumber), // STK-003
    index('batches_expires_on_idx').on(t.expiresOn).where(sql`${t.expiresOn} is not null`), // FEFO, expiry flags
    check('batches_expiry_after_manufacture', sql`${t.expiresOn} > ${t.manufacturedOn}`),
  ],
);

/**
 * The stock ledger (ADR-0001, DATA-MODEL §3.1). Signed legs in base units;
 * every group balances per batch (per variety for a conversion), checked at
 * commit by a constraint trigger. UPDATE, DELETE and TRUNCATE are revoked.
 */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: id(),
    groupId: uuid('group_id').notNull(),
    occurredAt: timestamptz('occurred_at').notNull(),
    batchId: uuid('batch_id').notNull().references(() => batches.id),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    accountKind: stockAccountKind('account_kind').notNull(),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),
    referenceType: stockReferenceType('reference_type').notNull(),
    referenceId: uuid('reference_id').notNull(),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
  },
  (t) => [
    check('stock_movements_quantity_nonzero', sql`${t.quantity} <> 0`),
    check('stock_movements_account_scope', sql`(
      ${t.accountKind} = 'WAREHOUSE' and ${t.warehouseId} is not null and ${t.vehicleId} is null
    ) or (
      ${t.accountKind} = 'VEHICLE' and ${t.vehicleId} is not null and ${t.warehouseId} is null
    ) or (
      ${t.accountKind} not in ('WAREHOUSE', 'VEHICLE') and ${t.warehouseId} is null and ${t.vehicleId} is null
    )`),
    index('stock_movements_position_idx').on(t.batchId, t.accountKind, t.warehouseId, t.vehicleId),
    index('stock_movements_group_id_idx').on(t.groupId),
    index('stock_movements_reference_idx').on(t.referenceType, t.referenceId),
    index('stock_movements_occurred_at_idx').on(t.occurredAt),
    index('stock_movements_warehouse_id_idx').on(t.warehouseId),
    index('stock_movements_vehicle_id_idx').on(t.vehicleId),
  ],
);
