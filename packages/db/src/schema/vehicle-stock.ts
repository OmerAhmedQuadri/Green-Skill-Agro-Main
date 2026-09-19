import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, numeric, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { attendanceDays } from './attendance';
import { skus } from './catalogue';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { mutable } from './mutable';
import { branches, warehouses } from './organisation';
import { batches } from './stock';
import { vehicles } from './vehicles';

// Mirror packages/core/src/vehicles/vehicles.ts and inventory/closing.ts.
export const loadStatus = pgEnum('load_status', ['ISSUED', 'CONFIRMED', 'DISPUTED', 'CANCELLED']);
export const vehicleReturnReason = pgEnum('vehicle_return_reason', [
  'EXPIRY_RECALL', 'REDISTRIBUTION', 'SELLER_LEAVING', 'STORE_RETURN', 'VEHICLE_WITHDRAWN', 'MANAGER_RECALL',
]);
export const closingStatus = pgEnum('closing_status', ['MATCHED', 'VARIANCE_FLAGGED', 'REVIEWED']);

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

/**
 * VEH-005..008, STATE-MACHINES §7: stock issued from the warehouse to a
 * vehicle. Held while ISSUED or DISPUTED; posted when the seller confirms.
 * Valued at the base price list against the seller's ceiling (ADR-0031).
 */
export const vehicleLoadouts = pgTable(
  'vehicle_loadouts',
  {
    id: id(),
    number: text('number').notNull().unique(),
    vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
    status: loadStatus('status').notNull().default('ISSUED'),
    loadValue: money('load_value').notNull(),
    vehicleValue: money('vehicle_value').notNull(), // on the vehicle when issued
    ceiling: money('ceiling'),
    ceilingAcknowledged: boolean('ceiling_acknowledged').notNull().default(false), // VEH-006: warned, went ahead
    issuedAt: timestamptz('issued_at').notNull(),
    issuedBy: uuid('issued_by').notNull().references(() => users.id),
    confirmedAt: timestamptz('confirmed_at'),
    disputedAt: timestamptz('disputed_at'),
    disputeComment: text('dispute_comment'),
    cancelledAt: timestamptz('cancelled_at'),
    cancelReason: text('cancel_reason'),
    movementGroupId: uuid('movement_group_id'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    index('vehicle_loadouts_vehicle_id_idx').on(t.vehicleId),
    index('vehicle_loadouts_seller_id_idx').on(t.sellerId),
    index('vehicle_loadouts_status_idx').on(t.status),
    check('vehicle_loadouts_confirmed', sql`(${t.status} = 'CONFIRMED') = (${t.movementGroupId} is not null)`),
  ],
);

export const vehicleLoadoutLines = pgTable(
  'vehicle_loadout_lines',
  {
    id: id(),
    loadoutId: uuid('loadout_id').notNull().references(() => vehicleLoadouts.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id').notNull().references(() => batches.id),
    packs: integer('packs').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unitPrice: money('unit_price'), // base price per pack when issued; null: unpriced
    disputeNote: text('dispute_note'), // VEH-007: the seller's comment on this line
  },
  (t) => [
    unique('vehicle_loadout_lines_batch_unique').on(t.loadoutId, t.batchId),
    index('vehicle_loadout_lines_batch_id_idx').on(t.batchId),
    check('vehicle_loadout_lines_packs_positive', sql`${t.packs} > 0`),
  ],
);

/** STK-012 (ADR-0031): stock back from a vehicle to the warehouse, posted when recorded. */
export const vehicleReturns = pgTable(
  'vehicle_returns',
  {
    id: id(),
    number: text('number').notNull().unique(),
    vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id),
    sellerId: uuid('seller_id').references(() => users.id), // assigned at the time, if any
    warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
    reason: vehicleReturnReason('reason').notNull(),
    note: text('note'),
    movementGroupId: uuid('movement_group_id').notNull(),
    recordedAt: timestamptz('recorded_at').notNull(),
    recordedBy: uuid('recorded_by').notNull().references(() => users.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [index('vehicle_returns_vehicle_id_idx').on(t.vehicleId)],
);

export const vehicleReturnLines = pgTable(
  'vehicle_return_lines',
  {
    id: id(),
    returnId: uuid('return_id').notNull().references(() => vehicleReturns.id),
    batchId: uuid('batch_id').notNull().references(() => batches.id),
    packs: integer('packs').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
  },
  (t) => [
    unique('vehicle_return_lines_batch_unique').on(t.returnId, t.batchId),
    index('vehicle_return_lines_batch_id_idx').on(t.batchId),
    check('vehicle_return_lines_packs_positive', sql`${t.packs} > 0`),
  ],
);

/**
 * STK-010, 011, STATE-MACHINES §11 (ADR-0033): the seller's count, per SKU,
 * once a day. Never adjusts stock; a variance waits for a manager's comment.
 */
export const closingStockDeclarations = pgTable(
  'closing_stock_declarations',
  {
    id: id(),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id),
    attendanceDayId: uuid('attendance_day_id').notNull().references(() => attendanceDays.id),
    workDate: date('work_date').notNull(),
    status: closingStatus('status').notNull(),
    declaredAt: timestamptz('declared_at').notNull(),
    reviewedAt: timestamptz('reviewed_at'),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewComment: text('review_comment'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    unique('closing_stock_one_per_day').on(t.sellerId, t.workDate),
    index('closing_stock_declarations_vehicle_id_idx').on(t.vehicleId),
    index('closing_stock_declarations_status_idx').on(t.status),
    check('closing_stock_reviewed', sql`(${t.status} = 'REVIEWED') = (${t.reviewedAt} is not null)`),
  ],
);

export const closingStockLines = pgTable(
  'closing_stock_lines',
  {
    id: id(),
    declarationId: uuid('declaration_id').notNull().references(() => closingStockDeclarations.id),
    skuId: uuid('sku_id').notNull().references(() => skus.id),
    declaredPacks: integer('declared_packs').notNull(),
    systemPacks: integer('system_packs').notNull(),
  },
  (t) => [
    unique('closing_stock_lines_sku_unique').on(t.declarationId, t.skuId),
    index('closing_stock_lines_sku_id_idx').on(t.skuId),
    check('closing_stock_lines_non_negative', sql`${t.declaredPacks} >= 0 and ${t.systemPacks} >= 0`),
  ],
);
