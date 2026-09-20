import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamptz } from './columns';
import { users } from './identity';
import { mutable } from './mutable';
import { branches } from './organisation';
import { batches } from './stock';
import { vehicles } from './vehicles';
import { writeOffs } from './warehouse';

// Mirror packages/core/src/vehicles/audits.
export const auditStatus = pgEnum('audit_status', ['IN_PROGRESS', 'CLOSED']);
export const auditOutcome = pgEnum('audit_outcome', ['MATCH', 'SHORTFALL', 'SURPLUS']);
export const surplusStatus = pgEnum('surplus_status', ['PENDING', 'APPROVED', 'REJECTED']);

/**
 * VEH-011..015, STATE-MACHINES §9, ADR-0041: a manager's physical count of a
 * vehicle's stock, recorded against the vehicle and the seller assigned to it.
 */
export const vehicleAudits = pgTable(
  'vehicle_audits',
  {
    id: id(),
    number: text('number').notNull().unique(),
    vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id),
    /** VEH-014: whoever held the vehicle when it was counted. */
    sellerId: uuid('seller_id').references(() => users.id),
    status: auditStatus('status').notNull().default('IN_PROGRESS'),
    openedAt: timestamptz('opened_at').notNull(),
    openedBy: uuid('opened_by').notNull().references(() => users.id),
    closedAt: timestamptz('closed_at'),
    closedBy: uuid('closed_by').references(() => users.id),
    note: text('note'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    uniqueIndex('vehicle_audits_one_open').on(t.vehicleId).where(sql`${t.status} = 'IN_PROGRESS'`),
    index('vehicle_audits_vehicle_closed_idx').on(t.vehicleId, t.closedAt),
    index('vehicle_audits_seller_id_idx').on(t.sellerId),
    index('vehicle_audits_opened_by_idx').on(t.openedBy),
    index('vehicle_audits_closed_by_idx').on(t.closedBy),
    check('vehicle_audits_closed', sql`(${t.status} = 'CLOSED') = (${t.closedAt} is not null and ${t.closedBy} is not null)`),
  ],
);

/** VEH-011..013, OQ-022: one batch counted — and where the difference went. */
export const vehicleAuditLines = pgTable(
  'vehicle_audit_lines',
  {
    id: id(),
    auditId: uuid('audit_id').notNull().references(() => vehicleAudits.id),
    batchId: uuid('batch_id').notNull().references(() => batches.id),
    /** The system's position when the audit opened, and again at close. */
    expectedPacks: integer('expected_packs').notNull(),
    countedPacks: integer('counted_packs'),
    comment: text('comment'),
    outcome: auditOutcome('outcome'),
    /** VEH-013: raised on close, approved like any other write-off. */
    writeOffId: uuid('write_off_id').references(() => writeOffs.id),
    /** OQ-022: a surplus waits for approval before the stock is added. */
    surplusStatus: surplusStatus('surplus_status'),
    surplusDecidedAt: timestamptz('surplus_decided_at'),
    surplusDecidedBy: uuid('surplus_decided_by').references(() => users.id),
    surplusComment: text('surplus_comment'),
    movementGroupId: uuid('movement_group_id'),
    ...mutable(),
  },
  (t) => [
    uniqueIndex('vehicle_audit_lines_unique').on(t.auditId, t.batchId),
    index('vehicle_audit_lines_batch_id_idx').on(t.batchId),
    index('vehicle_audit_lines_write_off_id_idx').on(t.writeOffId),
    index('vehicle_audit_lines_surplus_idx').on(t.surplusStatus),
    index('vehicle_audit_lines_surplus_decided_by_idx').on(t.surplusDecidedBy),
    check('vehicle_audit_lines_counts', sql`${t.expectedPacks} >= 0 and (${t.countedPacks} is null or ${t.countedPacks} >= 0)`),
    check('vehicle_audit_lines_surplus_decided', sql`(${t.surplusStatus} in ('APPROVED', 'REJECTED')) = (${t.surplusDecidedAt} is not null and ${t.surplusDecidedBy} is not null)`),
  ],
);
