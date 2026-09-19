import { sql } from 'drizzle-orm';
import { check, index, integer, numeric, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { branches, warehouses } from './organisation';
import { cashLedgerEntries, saleLines, sales } from './sales';
import { batches } from './stock';
import { storeLedgerEntries, stores } from './stores';
import { vehicles } from './vehicles';

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

// Mirror packages/core/src/returns.
export const returnKind = pgEnum('return_kind', ['CREDIT_NOTE', 'REPLACEMENT']);
export const returnCondition = pgEnum('return_condition', ['UNCLEARED_PAYMENT', 'DEFECTIVE', 'NOT_RECEIVED']);
export const returnOutcome = pgEnum('return_outcome', ['RESTOCK', 'WRITE_OFF']);

/**
 * RET-001..012, ADR-0039: goods back from a store, always against the sale
 * they were sold on. A credit note (`CN-`) moves money — this sale's unpaid
 * part, the store's other debts, then a cash refund; a replacement (`RP-`)
 * is stock for stock. Append-only: nothing about a return changes later.
 */
export const returns = pgTable(
  'returns',
  {
    id: id(),
    number: text('number').notNull().unique(),
    kind: returnKind('kind').notNull(),
    condition: returnCondition('condition').notNull(),
    saleId: uuid('sale_id').notNull().references(() => sales.id),
    storeId: uuid('store_id').notNull().references(() => stores.id),
    sellerId: uuid('seller_id').notNull().references(() => users.id), // the sale's seller (RET-009)
    processedBy: uuid('processed_by').notNull().references(() => users.id),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),       // restocked onto, or replaced from
    warehouseId: uuid('warehouse_id').references(() => warehouses.id), // restocked into, from the console
    amount: money('amount').notNull(),
    toSale: money('to_sale').notNull(),
    toOtherDebts: money('to_other_debts').notNull(),
    refund: money('refund').notNull(),
    /** OQ-012: owed to the store but not handed over — a manager has no cash; the seller pays it on a later visit. */
    refundDue: money('refund_due').notNull().default('0.00'),
    collectedPortion: money('collected_portion').notNull(), // COM-009, for M11
    storeLedgerEntryId: uuid('store_ledger_entry_id').references(() => storeLedgerEntries.id),
    cashLedgerEntryId: uuid('cash_ledger_entry_id').references(() => cashLedgerEntries.id),
    movementGroupId: uuid('movement_group_id').notNull(),
    note: text('note'),
    occurredAt: timestamptz('occurred_at').notNull(),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('returns_sale_id_idx').on(t.saleId),
    index('returns_store_id_idx').on(t.storeId),
    index('returns_seller_occurred_idx').on(t.sellerId, t.occurredAt),
    index('returns_processed_by_idx').on(t.processedBy),
    index('returns_vehicle_id_idx').on(t.vehicleId),
    index('returns_warehouse_id_idx').on(t.warehouseId),
    index('returns_store_ledger_entry_id_idx').on(t.storeLedgerEntryId),
    index('returns_cash_ledger_entry_id_idx').on(t.cashLedgerEntryId),
    check('returns_kind', sql`(${t.kind} = 'CREDIT_NOTE' and ${t.amount} > 0) or (${t.kind} = 'REPLACEMENT' and ${t.amount} = 0 and ${t.condition} = 'DEFECTIVE' and ${t.vehicleId} is not null)`),
    check('returns_split', sql`${t.amount} = ${t.toSale} + ${t.toOtherDebts} + ${t.refund} + ${t.refundDue} and ${t.toSale} >= 0 and ${t.toOtherDebts} >= 0 and ${t.refund} >= 0 and ${t.refundDue} >= 0`),
    check('returns_collected', sql`${t.collectedPortion} = ${t.toOtherDebts} + ${t.refund} + ${t.refundDue}`),
    check('returns_one_place', sql`${t.vehicleId} is null or ${t.warehouseId} is null`),
    check('returns_ledger', sql`(${t.toSale} + ${t.toOtherDebts} > 0) = (${t.storeLedgerEntryId} is not null)`),
    check('returns_cash', sql`(${t.refund} > 0) = (${t.cashLedgerEntryId} is not null)`),
  ],
);

/** RET-007, RET-010: each batch that came back from a sale line — restocked or written off — and what it was credited. */
export const returnLines = pgTable(
  'return_lines',
  {
    id: id(),
    returnId: uuid('return_id').notNull().references(() => returns.id),
    saleLineId: uuid('sale_line_id').notNull().references(() => saleLines.id),
    batchId: uuid('batch_id').notNull().references(() => batches.id),
    packs: integer('packs').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    outcome: returnOutcome('outcome').notNull(),
    amount: money('amount').notNull(),
  },
  (t) => [
    uniqueIndex('return_lines_unique').on(t.returnId, t.saleLineId, t.batchId, t.outcome),
    index('return_lines_sale_line_id_idx').on(t.saleLineId),
    index('return_lines_batch_id_idx').on(t.batchId),
    check('return_lines_packs_positive', sql`${t.packs} > 0 and ${t.quantity} > 0`),
    check('return_lines_amount', sql`${t.amount} >= 0`),
  ],
);

/** RET-010: the vehicle batches a replacement was handed over from, soonest expiry first. */
export const returnReplacements = pgTable(
  'return_replacements',
  {
    id: id(),
    returnLineId: uuid('return_line_id').notNull().references(() => returnLines.id),
    batchId: uuid('batch_id').notNull().references(() => batches.id),
    packs: integer('packs').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
  },
  (t) => [
    uniqueIndex('return_replacements_unique').on(t.returnLineId, t.batchId),
    index('return_replacements_batch_id_idx').on(t.batchId),
    check('return_replacements_packs_positive', sql`${t.packs} > 0 and ${t.quantity} > 0`),
  ],
);

/**
 * OQ-012: a refund a manager could not hand over, paid by the seller from
 * their cash in hand on a later visit. Append-only; what is still owed is the
 * return's `refund_due` less what has been paid.
 */
export const refundPayments = pgTable(
  'refund_payments',
  {
    id: id(),
    returnId: uuid('return_id').notNull().references(() => returns.id),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    amount: money('amount').notNull(),
    cashLedgerEntryId: uuid('cash_ledger_entry_id').notNull().references(() => cashLedgerEntries.id),
    paidAt: timestamptz('paid_at').notNull(),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('refund_payments_return_id_idx').on(t.returnId),
    index('refund_payments_seller_id_idx').on(t.sellerId),
    index('refund_payments_cash_ledger_entry_id_idx').on(t.cashLedgerEntryId),
    check('refund_payments_amount_positive', sql`${t.amount} > 0`),
  ],
);
