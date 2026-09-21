import { sql } from 'drizzle-orm';
import { check, date, index, integer, numeric, pgEnum, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { mediaAssets } from './media';
import { mutable } from './mutable';
import { branches } from './organisation';
import { priceLists } from './pricing';

// Mirror packages/core/src/stores.
export const storeStatus = pgEnum('store_status', ['PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'INACTIVE']);
export const creditMode = pgEnum('credit_mode', ['BILL_TO_BILL', 'WEEKLY', 'MONTHLY', 'CUSTOM']);
export const storeLedgerEntryType = pgEnum('store_ledger_entry_type', ['SALE', 'PAYMENT', 'CREDIT_NOTE', 'ADJUSTMENT']);
export const paymentMethod = pgEnum('payment_method', ['CASH', 'BANK_TRANSFER']);

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

/**
 * STO-001..010, DATA-MODEL §5.6. Stores belong to Green Skill Agro (STO-006); the
 * account manager is in `store_assignments`. Credit blocking is derived at
 * the point of sale from the ledger, never stored (STATE-MACHINES §4).
 */
export const stores = pgTable(
  'stores',
  {
    id: id(),
    name: text('name').notNull(),
    ownerName: text('owner_name').notNull(),
    contactNumber: text('contact_number').notNull(),
    category: text('category'),
    latitude: numeric('latitude', { precision: 9, scale: 6 }).notNull(),   // STO-003, captured automatically
    longitude: numeric('longitude', { precision: 9, scale: 6 }).notNull(),
    address: text('address'),
    crNumber: text('cr_number'),                // STO-004: all three optional
    vatNumber: text('vat_number'),
    nationalAddress: text('national_address'),
    creditMode: creditMode('credit_mode').notNull(),
    creditCycleDays: integer('credit_cycle_days'),  // CUSTOM only
    creditLimit: money('credit_limit').notNull().default('0'),
    priceListId: uuid('price_list_id').notNull().references(() => priceLists.id),
    status: storeStatus('status').notNull(),
    storefrontMediaId: uuid('storefront_media_id').references(() => mediaAssets.id),
    decidedAt: timestamptz('decided_at'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decisionReason: text('decision_reason'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    index('stores_location_idx').on(t.latitude, t.longitude), // STO-008: the candidate box
    index('stores_status_idx').on(t.status),
    index('stores_price_list_id_idx').on(t.priceListId),
    index('stores_storefront_media_id_idx').on(t.storefrontMediaId),
    check('stores_custom_cycle_days', sql`(${t.creditMode} = 'CUSTOM') = (${t.creditCycleDays} is not null)`),
    check('stores_credit_limit_non_negative', sql`${t.creditLimit} >= 0`),
  ],
);

/** STO-006, 007: the seller accountable for a store, with the full history. */
export const storeAssignments = pgTable(
  'store_assignments',
  {
    id: id(),
    storeId: uuid('store_id').notNull().references(() => stores.id),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    startedAt: timestamptz('started_at').notNull(),
    endedAt: timestamptz('ended_at'),
    assignedBy: uuid('assigned_by').notNull().references(() => users.id),
    note: text('note'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('store_assignments_one_open').on(t.storeId).where(sql`${t.endedAt} is null`),
    index('store_assignments_seller_id_idx').on(t.sellerId),
    index('store_assignments_store_id_idx').on(t.storeId, t.startedAt),
  ],
);

/**
 * The credit ledger (DATA-MODEL §3.2, ADR-0036). Signed: + increases what the
 * store owes. Every debit carries its due date, fixed when posted. Append-only.
 */
export const storeLedgerEntries = pgTable(
  'store_ledger_entries',
  {
    id: id(),
    storeId: uuid('store_id').notNull().references(() => stores.id),
    occurredAt: timestamptz('occurred_at').notNull(),
    entryType: storeLedgerEntryType('entry_type').notNull(),
    amount: money('amount').notNull(),
    dueOn: date('due_on'),
    referenceType: text('reference_type').notNull(),
    referenceId: uuid('reference_id').notNull(),
    note: text('note'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
  },
  (t) => [
    index('store_ledger_entries_store_idx').on(t.storeId, t.occurredAt),
    index('store_ledger_entries_reference_idx').on(t.referenceType, t.referenceId),
    check('store_ledger_amount_nonzero', sql`${t.amount} <> 0`),
    check('store_ledger_sign', sql`(${t.entryType} = 'SALE' and ${t.amount} > 0) or (${t.entryType} in ('PAYMENT', 'CREDIT_NOTE') and ${t.amount} < 0) or ${t.entryType} = 'ADJUSTMENT'`),
    check('store_ledger_debit_due', sql`(${t.amount} > 0) = (${t.dueOn} is not null)`),
  ],
);

/** CRD-003: a payment collected from a store — its ledger entry is the credit. Append-only. */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    number: text('number').notNull().unique(),
    storeId: uuid('store_id').notNull().references(() => stores.id),
    amount: money('amount').notNull(),
    method: paymentMethod('method').notNull(),
    reference: text('reference'),
    receivedAt: timestamptz('received_at').notNull(),
    receivedBy: uuid('received_by').notNull().references(() => users.id),
    ledgerEntryId: uuid('ledger_entry_id').notNull().references(() => storeLedgerEntries.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('payments_store_id_idx').on(t.storeId),
    index('payments_received_by_idx').on(t.receivedBy, t.receivedAt),
    index('payments_ledger_entry_id_idx').on(t.ledgerEntryId),
    check('payments_amount_positive', sql`${t.amount} > 0`),
    check('payments_transfer_reference', sql`${t.method} <> 'BANK_TRANSFER' or ${t.reference} is not null`),
  ],
);

/**
 * Which credits settled which debits, oldest due first (ADR-0036). RET-002 and
 * the commission's collected portion (OQ-002) read it. Append-only.
 */
export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    creditEntryId: uuid('credit_entry_id').notNull().references(() => storeLedgerEntries.id),
    debitEntryId: uuid('debit_entry_id').notNull().references(() => storeLedgerEntries.id),
    amount: money('amount').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.creditEntryId, t.debitEntryId] }),
    index('payment_allocations_debit_idx').on(t.debitEntryId),
    check('payment_allocations_amount_positive', sql`${t.amount} > 0`),
  ],
);

/** CRD-006, 007 (OQ-018): a blocked store released for one sale, the same business day. */
export const creditOverrides = pgTable(
  'credit_overrides',
  {
    id: id(),
    storeId: uuid('store_id').notNull().references(() => stores.id),
    reason: text('reason').notNull(),
    businessDate: date('business_date').notNull(),
    grantedAt: timestamptz('granted_at').notNull(),
    grantedBy: uuid('granted_by').notNull().references(() => users.id),
    usedAt: timestamptz('used_at'),
    usedReferenceId: uuid('used_reference_id'), // the sale that used it (M6)
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('credit_overrides_one_open').on(t.storeId, t.businessDate).where(sql`${t.usedAt} is null`),
    index('credit_overrides_store_id_idx').on(t.storeId),
  ],
);
