import { sql } from 'drizzle-orm';
import { check, index, integer, numeric, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { mediaAssets } from './media';
import { mutable } from './mutable';
import { branches, warehouses } from './organisation';
import { saleLines, sales } from './sales';
import { batches } from './stock';
import { stores } from './stores';

// Mirror packages/core/src/dispatch.
export const dispatchStatus = pgEnum('dispatch_status', ['REQUESTED', 'BEING_HANDLED', 'RELEASED', 'DELIVERED', 'CLOSED']);
export const dispatchCloseReason = pgEnum('dispatch_close_reason', ['DELIVERED', 'CANCELLED', 'LOST']);
export const confirmationMode = pgEnum('confirmation_mode', ['IN_PERSON', 'OWNER_WORD']);
export const shortfallResolution = pgEnum('shortfall_resolution', ['FROM_VEHICLE', 'FURTHER_ORDER', 'NOT_NEEDED']);
export const lostClaimStatus = pgEnum('lost_claim_status', ['PENDING', 'APPROVED', 'REJECTED']);
export const dispatchEventType = pgEnum('dispatch_event_type', [
  'RAISED', 'TAKEN', 'RELEASED_BACK', 'RELEASED', 'CONFIRMED', 'RESOLVED', 'CANCELLED', 'CLAIMED', 'CLAIM_APPROVED', 'CLAIM_REJECTED',
]);

/**
 * DSP-001..017, STATE-MACHINES §3, ADR-0038: goods sent from the warehouse to
 * a store by hired transport. The sale it carries stays pending until the
 * seller confirms receipt.
 */
export const dispatchOrders = pgTable(
  'dispatch_orders',
  {
    id: id(),
    number: text('number').notNull().unique(),
    saleId: uuid('sale_id').notNull().unique().references(() => sales.id),
    storeId: uuid('store_id').notNull().references(() => stores.id),
    sellerId: uuid('seller_id').notNull().references(() => users.id), // the seller of record (DSP-015)
    raisedBy: uuid('raised_by').notNull().references(() => users.id),
    warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
    status: dispatchStatus('status').notNull().default('REQUESTED'),
    handledBy: uuid('handled_by').references(() => users.id), // DSP-004: an advisory label
    handledAt: timestamptz('handled_at'),
    releasedAt: timestamptz('released_at'),
    releasedBy: uuid('released_by').references(() => users.id),
    transportSlipMediaId: uuid('transport_slip_media_id').references(() => mediaAssets.id), // DSP-006
    transportNote: text('transport_note'),
    confirmedAt: timestamptz('confirmed_at'),
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    confirmationMode: confirmationMode('confirmation_mode'), // DSP-010
    resolution: shortfallResolution('resolution'),           // DSP-011, 012
    closedAt: timestamptz('closed_at'),
    closeReason: dispatchCloseReason('close_reason'),
    cancelReason: text('cancel_reason'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    index('dispatch_orders_status_idx').on(t.status),
    index('dispatch_orders_seller_id_idx').on(t.sellerId),
    index('dispatch_orders_store_id_idx').on(t.storeId),
    index('dispatch_orders_raised_by_idx').on(t.raisedBy),
    index('dispatch_orders_handled_by_idx').on(t.handledBy),
    index('dispatch_orders_released_by_idx').on(t.releasedBy),
    index('dispatch_orders_confirmed_by_idx').on(t.confirmedBy),
    index('dispatch_orders_warehouse_id_idx').on(t.warehouseId),
    index('dispatch_orders_transport_slip_media_id_idx').on(t.transportSlipMediaId),
    check('dispatch_orders_released', sql`(${t.status} in ('RELEASED', 'DELIVERED') or ${t.closeReason} in ('DELIVERED', 'LOST')) = (${t.releasedAt} is not null and ${t.transportSlipMediaId} is not null)`),
    check('dispatch_orders_confirmed', sql`(${t.confirmedAt} is not null) = (${t.confirmationMode} is not null)`),
    check('dispatch_orders_closed', sql`(${t.status} = 'CLOSED') = (${t.closedAt} is not null and ${t.closeReason} is not null)`),
  ],
);

/** One per sale line: packs ordered, released, and — on receipt — received, short, damaged. */
export const dispatchOrderLines = pgTable(
  'dispatch_order_lines',
  {
    id: id(),
    orderId: uuid('order_id').notNull().references(() => dispatchOrders.id),
    saleLineId: uuid('sale_line_id').notNull().unique().references(() => saleLines.id),
    packs: integer('packs').notNull(),
    receivedPacks: integer('received_packs'),
    shortPacks: integer('short_packs'),
    damagedPacks: integer('damaged_packs'),
  },
  (t) => [
    index('dispatch_order_lines_order_id_idx').on(t.orderId),
    check('dispatch_order_lines_packs_positive', sql`${t.packs} > 0`),
    check('dispatch_order_lines_receipt', sql`(${t.receivedPacks} is null and ${t.shortPacks} is null and ${t.damagedPacks} is null)
      or (${t.receivedPacks} >= 0 and ${t.shortPacks} >= 0 and ${t.damagedPacks} >= 0 and ${t.receivedPacks} + ${t.shortPacks} + ${t.damagedPacks} = ${t.packs})`),
  ],
);

/** DSP-007: the batches released for a line, FEFO from the warehouse. Append-only. */
export const dispatchLineBatches = pgTable(
  'dispatch_line_batches',
  {
    id: id(),
    orderLineId: uuid('order_line_id').notNull().references(() => dispatchOrderLines.id),
    batchId: uuid('batch_id').notNull().references(() => batches.id),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
  },
  (t) => [
    uniqueIndex('dispatch_line_batches_unique').on(t.orderLineId, t.batchId),
    index('dispatch_line_batches_batch_id_idx').on(t.batchId),
    check('dispatch_line_batches_quantity_positive', sql`${t.quantity} > 0`),
  ],
);

/** DSP-004: who did what to an order, and when. Append-only. */
export const dispatchOrderEvents = pgTable(
  'dispatch_order_events',
  {
    id: id(),
    orderId: uuid('order_id').notNull().references(() => dispatchOrders.id),
    type: dispatchEventType('type').notNull(),
    actorId: uuid('actor_id').references(() => users.id),
    note: text('note'),
    occurredAt: timestamptz('occurred_at').notNull(),
  },
  (t) => [
    index('dispatch_order_events_order_idx').on(t.orderId, t.occurredAt),
    index('dispatch_order_events_actor_id_idx').on(t.actorId),
  ],
);

/** DSP-013: nothing arrived. Approved, the stock is written off and the sale cancelled. */
export const lostOrderClaims = pgTable(
  'lost_order_claims',
  {
    id: id(),
    orderId: uuid('order_id').notNull().references(() => dispatchOrders.id),
    status: lostClaimStatus('status').notNull().default('PENDING'),
    reason: text('reason').notNull(),
    raisedBy: uuid('raised_by').notNull().references(() => users.id),
    raisedAt: timestamptz('raised_at').notNull(),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamptz('decided_at'),
    comment: text('comment'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('lost_order_claims_one_pending').on(t.orderId).where(sql`${t.status} = 'PENDING'`),
    index('lost_order_claims_order_id_idx').on(t.orderId),
    index('lost_order_claims_raised_by_idx').on(t.raisedBy),
    index('lost_order_claims_decided_by_idx').on(t.decidedBy),
    check('lost_order_claims_decided', sql`(${t.status} = 'PENDING') = (${t.decidedAt} is null)`),
  ],
);
