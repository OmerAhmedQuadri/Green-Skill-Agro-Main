import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { mutable } from './mutable';
import { branches } from './organisation';

// Mirror packages/core/src/vehicles/vehicles.ts.
export const vehicleStatus = pgEnum('vehicle_status', ['ACTIVE', 'MAINTENANCE', 'RETIRED']);
export const handoverStatus = pgEnum('handover_status', ['PROPOSED', 'CONFIRMED', 'CANCELLED']);

/**
 * VEH-001: the register. Stock belongs to the vehicle, not the seller
 * (VEH-003). The current odometer reading is the latest row in
 * `odometer_readings` (VEH-004), never a column here.
 */
export const vehicles = pgTable(
  'vehicles',
  {
    id: id(),
    registration: text('registration').notNull().unique(),
    description: text('description'),
    status: vehicleStatus('status').notNull().default('ACTIVE'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [index('vehicles_branch_id_idx').on(t.branchId)],
);

/**
 * VEH-002: a vehicle assigned to a seller for a period; every row kept. The
 * current seller is the row with `ended_at IS NULL` — one per vehicle, one per
 * seller (ADR-0031).
 */
export const vehicleAssignments = pgTable(
  'vehicle_assignments',
  {
    id: id(),
    vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    startedAt: timestamptz('started_at').notNull(),
    endedAt: timestamptz('ended_at'),
    assignedBy: uuid('assigned_by').notNull().references(() => users.id),
    endedBy: uuid('ended_by').references(() => users.id),
    endNote: text('end_note'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('vehicle_assignments_one_per_vehicle').on(t.vehicleId).where(sql`${t.endedAt} is null`),
    uniqueIndex('vehicle_assignments_one_per_seller').on(t.sellerId).where(sql`${t.endedAt} is null`),
    index('vehicle_assignments_vehicle_id_idx').on(t.vehicleId, t.startedAt),
    index('vehicle_assignments_seller_id_idx').on(t.sellerId),
    check('vehicle_assignments_period', sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`),
  ],
);

/**
 * VEH-009, STATE-MACHINES §8: reassigning a vehicle that carries stock. Both
 * sellers confirm; nothing moves. The stock list at completion is the record.
 */
export const vehicleHandovers = pgTable(
  'vehicle_handovers',
  {
    id: id(),
    vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id),
    outgoingSellerId: uuid('outgoing_seller_id').notNull().references(() => users.id),
    incomingSellerId: uuid('incoming_seller_id').notNull().references(() => users.id),
    status: handoverStatus('status').notNull().default('PROPOSED'),
    proposedAt: timestamptz('proposed_at').notNull(),
    proposedBy: uuid('proposed_by').notNull().references(() => users.id),
    outgoingConfirmedAt: timestamptz('outgoing_confirmed_at'),
    incomingConfirmedAt: timestamptz('incoming_confirmed_at'),
    completedAt: timestamptz('completed_at'),
    cancelledAt: timestamptz('cancelled_at'),
    cancelReason: text('cancel_reason'),
    /** At completion: [{ skuId, code, packs }] — what passed from one seller to the other. */
    stockList: jsonb('stock_list'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    uniqueIndex('vehicle_handovers_one_open').on(t.vehicleId).where(sql`${t.status} = 'PROPOSED'`),
    index('vehicle_handovers_outgoing_idx').on(t.outgoingSellerId),
    index('vehicle_handovers_incoming_idx').on(t.incomingSellerId),
    check('vehicle_handovers_two_sellers', sql`${t.outgoingSellerId} <> ${t.incomingSellerId}`),
    check('vehicle_handovers_completed', sql`(${t.status} = 'CONFIRMED') = (${t.completedAt} is not null)`),
  ],
);
