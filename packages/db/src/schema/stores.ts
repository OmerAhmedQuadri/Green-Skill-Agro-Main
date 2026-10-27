import { sql } from 'drizzle-orm';
import { check, date, index, integer, numeric, pgEnum, pgTable, primaryKey, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { storeCorrections } from './corrections';
import { users } from './identity';
import { importBatches } from './imports';
import { mediaAssets } from './media';
import { mutable } from './mutable';
import { branches } from './organisation';
import { priceLists } from './pricing';

// Mirror packages/core/src/stores.
export const storeStatus = pgEnum('store_status', ['PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'INACTIVE', 'AWAITING_REVERIFICATION']);
export const balanceConfirmation = pgEnum('balance_confirmation', ['AGREED', 'DISPUTED']);
export const storeStatementStatus = pgEnum('store_statement_status', ['PENDING', 'READY', 'FAILED']);
export const creditMode = pgEnum('credit_mode', ['BILL_TO_BILL', 'WEEKLY', 'MONTHLY', 'CUSTOM']);
export const storeLedgerEntryType = pgEnum('store_ledger_entry_type', ['SALE', 'PAYMENT', 'CREDIT_NOTE', 'ADJUSTMENT']);
export const paymentMethod = pgEnum('payment_method', ['CASH', 'BANK_TRANSFER']);
// Mirror packages/core/src/imports (ADR-0059).
export const entryOrigin = pgEnum('entry_origin', ['APP', 'IMPORT']);
export const importedPaymentKind = pgEnum('imported_payment_kind', ['VOUCHER', 'PAID_AT_SALE']);

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
    /** DOC-009 (ADR-0053): GSA-S-0001…, the Customer ID its delivery documents carry. */
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    // IMP-008: owner, phone, location and terms are empty only while an imported store awaits re-verification.
    ownerName: text('owner_name'),
    contactNumber: text('contact_number'),
    category: text('category'),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),   // STO-003, captured automatically
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    address: text('address'),
    crNumber: text('cr_number'),                // STO-004: all three optional
    vatNumber: text('vat_number'),
    nationalAddress: text('national_address'),
    creditMode: creditMode('credit_mode'),
    creditCycleDays: integer('credit_cycle_days'),  // CUSTOM only
    creditLimit: money('credit_limit').notNull().default('0'),
    priceListId: uuid('price_list_id').notNull().references(() => priceLists.id),
    status: storeStatus('status').notNull(),
    storefrontMediaId: uuid('storefront_media_id').references(() => mediaAssets.id),
    decidedAt: timestamptz('decided_at'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decisionReason: text('decision_reason'),
    /** IMP-008: imported from Green Agro's books in this batch, rather than onboarded in the app. */
    importBatchId: uuid('import_batch_id').references(() => importBatches.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    index('stores_location_idx').on(t.latitude, t.longitude), // STO-008: the candidate box
    index('stores_import_batch_id_idx').on(t.importBatchId),
    // Written without naming AWAITING_REVERIFICATION, which this migration adds: every other status has the details.
    check('stores_details', sql`${t.status} not in ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'INACTIVE') or (${t.ownerName} is not null
      and ${t.contactNumber} is not null and ${t.latitude} is not null and ${t.longitude} is not null and ${t.creditMode} is not null)`),
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
    /** IMP-003: posted from Green Agro's books, from this batch (ADR-0059), or recorded in the app. */
    origin: entryOrigin('origin').notNull().default('APP'),
    importBatchId: uuid('import_batch_id').references(() => importBatches.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
  },
  (t) => [
    index('store_ledger_entries_store_idx').on(t.storeId, t.occurredAt),
    index('store_ledger_entries_reference_idx').on(t.referenceType, t.referenceId),
    index('store_ledger_entries_import_batch_id_idx').on(t.importBatchId),
    // IMP-005: an imported sale goes into the account once. Corrections of it reference the correction instead.
    uniqueIndex('store_ledger_entries_imported_once').on(t.referenceType, t.referenceId).where(sql`${t.origin} = 'IMPORT' and ${t.referenceType} = 'IMPORTED_SALE'`),
    check('store_ledger_import_batch', sql`(${t.origin} = 'IMPORT') = (${t.importBatchId} is not null)`),
    check('store_ledger_amount_nonzero', sql`${t.amount} <> 0`),
    check('store_ledger_sign', sql`(${t.entryType} = 'SALE' and ${t.amount} > 0) or (${t.entryType} in ('PAYMENT', 'CREDIT_NOTE') and ${t.amount} < 0) or ${t.entryType} = 'ADJUSTMENT'`),
    check('store_ledger_debit_due', sql`(${t.amount} > 0) = (${t.dueOn} is not null)`),
  ],
);

/**
 * CRD-003: a payment collected from a store — its ledger entry is the credit.
 * Append-only. ADR-0052: an open sale's payment has neither store nor ledger
 * entry; its sale points at it.
 */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    number: text('number').notNull().unique(),
    storeId: uuid('store_id').references(() => stores.id),
    amount: money('amount').notNull(),
    method: paymentMethod('method').notNull(),
    reference: text('reference'),
    receivedAt: timestamptz('received_at').notNull(),
    receivedBy: uuid('received_by').notNull().references(() => users.id),
    ledgerEntryId: uuid('ledger_entry_id').references(() => storeLedgerEntries.id),
    /**
     * ADR-0047: the voucher handed to the store — the number printed on it,
     * as `core/stores` keeps it, and its photo. Required from 0022 on; a
     * payment recorded before then has none.
     */
    voucherNumber: text('voucher_number'),
    voucherPhotoId: uuid('voucher_photo_id').references(() => mediaAssets.id),
    /** IMP-003: posted from an imported payment of Green Agro's books (ADR-0059), or taken in the app. */
    origin: entryOrigin('origin').notNull().default('APP'),
    importBatchId: uuid('import_batch_id').references(() => importBatches.id),
    importedPaymentId: uuid('imported_payment_id').references(() => importedPayments.id),
    /** COR-005 (ADR-0059): the correction that recorded this payment, correcting another. */
    correctionId: uuid('correction_id').references((): AnyPgColumn => storeCorrections.id),
    /**
     * COR-005: the correction that replaced or removed this payment. Set once, and the only change the app may make
     * to a payment (migration 0032); from then on it no longer stands, and its corrected payment does.
     */
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => storeCorrections.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('payments_store_id_idx').on(t.storeId),
    index('payments_import_batch_id_idx').on(t.importBatchId),
    index('payments_correction_id_idx').on(t.correctionId),
    index('payments_superseded_by_idx').on(t.supersededBy),
    // IMP-005: an imported payment is posted once — its corrections replace it.
    uniqueIndex('payments_imported_payment_unique').on(t.importedPaymentId).where(sql`${t.importedPaymentId} is not null and ${t.supersededBy} is null`),
    check('payments_import_source', sql`(${t.origin} = 'IMPORT') = (${t.importBatchId} is not null)
      and (${t.origin} = 'IMPORT') = (${t.importedPaymentId} is not null)`),
    // A voucher number is used once in the whole business (ADR-0047), among the payments that stand (COR-005).
    uniqueIndex('payments_voucher_number_unique').on(t.voucherNumber).where(sql`${t.voucherNumber} is not null and ${t.supersededBy} is null`),
    index('payments_voucher_photo_id_idx').on(t.voucherPhotoId),
    index('payments_received_by_idx').on(t.receivedBy, t.receivedAt),
    index('payments_ledger_entry_id_idx').on(t.ledgerEntryId),
    check('payments_amount_positive', sql`${t.amount} > 0`),
    check('payments_store_ledger', sql`(${t.storeId} is null) = (${t.ledgerEntryId} is null)`),
    check('payments_transfer_reference', sql`${t.method} <> 'BANK_TRANSFER' or ${t.reference} is not null`),
  ],
);

/**
 * IMP-002 (ADR-0059): a payment from a seller's books, as written — a voucher, or money a September invoice book
 * shows paid against an invoice without one (PAID_AT_SALE, for its `invoice_serial`). Recorded, never posted at
 * import: it becomes a `payments` row when the seller re-verifies the store (IMP-005). Nobody could place a payment
 * with no store; it waits as a warning (IMP-009). Append-only.
 */
export const importedPayments = pgTable(
  'imported_payments',
  {
    id: id(),
    batchId: uuid('batch_id').notNull().references(() => importBatches.id),
    storeId: uuid('store_id').references(() => stores.id),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    paidOn: date('paid_on').notNull(),
    amount: money('amount').notNull(),
    kind: importedPaymentKind('kind').notNull(),
    method: paymentMethod('method').notNull(),
    /** As written in the voucher book; a few vouchers carry none (IMP-009). */
    voucherNumber: text('voucher_number'),
    invoiceSerial: integer('invoice_serial'),
    /** IMP-003: where it was written — the book and its row. */
    book: text('book').notNull(),
    bookRow: integer('book_row').notNull(),
    storeNameWritten: text('store_name_written').notNull(),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
  },
  (t) => [
    index('imported_payments_batch_id_idx').on(t.batchId),
    index('imported_payments_store_id_idx').on(t.storeId),
    index('imported_payments_seller_id_idx').on(t.sellerId),
    uniqueIndex('imported_payments_voucher_unique').on(t.batchId, t.voucherNumber).where(sql`${t.voucherNumber} is not null`),
    check('imported_payments_amount_positive', sql`${t.amount} > 0`),
    check('imported_payments_kind', sql`(${t.kind} = 'PAID_AT_SALE') = (${t.invoiceSerial} is not null)
      and (${t.kind} = 'VOUCHER' or ${t.voucherNumber} is null)`),
    check('imported_payments_book_row', sql`${t.bookRow} > 0`),
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

/**
 * IMP-005, IMP-008 (ADR-0059): an imported store re-verified by its seller — the balance its books came to, shown to
 * the store, and whether the store agreed. A dispute carries the store's words and is flagged for the Super Admin.
 * Its imported sales and payments went into its account at this moment. Append-only.
 */
export const storeReverifications = pgTable(
  'store_reverifications',
  {
    id: id(),
    storeId: uuid('store_id').notNull().references(() => stores.id),
    importedBalance: money('imported_balance').notNull(),
    confirmation: balanceConfirmation('confirmation').notNull(),
    disputeNote: text('dispute_note'),
    reverifiedAt: timestamptz('reverified_at').notNull(),
    reverifiedBy: uuid('reverified_by').notNull().references(() => users.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('store_reverifications_store_unique').on(t.storeId),
    index('store_reverifications_reverified_by_idx').on(t.reverifiedBy),
    check('store_reverifications_dispute', sql`(${t.confirmation} = 'DISPUTED') = (${t.disputeNote} is not null)`),
  ],
);

/**
 * IMP-010 (ADR-0059): a store's statement — its account as it stood when it was asked for (`as_of`), every entry
 * labelled, imported and app alike — printed to PDF by the worker as a stored file of kind STORE_STATEMENT, which the
 * storage policy keeps for its period. Mutable while it is printed.
 */
export const storeStatements = pgTable(
  'store_statements',
  {
    id: id(),
    /** ST-YYYY-NNNN. */
    number: text('number').notNull().unique(),
    storeId: uuid('store_id').notNull().references(() => stores.id),
    asOf: timestamptz('as_of').notNull(),
    status: storeStatementStatus('status').notNull().default('PENDING'),
    mediaId: uuid('media_id').references(() => mediaAssets.id),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    lastError: text('last_error'),
    requestedBy: uuid('requested_by').notNull().references(() => users.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    index('store_statements_store_id_idx').on(t.storeId, t.asOf),
    index('store_statements_media_id_idx').on(t.mediaId),
    index('store_statements_requested_by_idx').on(t.requestedBy),
    index('store_statements_due_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'PENDING'`),
    check('store_statements_ready', sql`(${t.status} = 'READY') = (${t.mediaId} is not null)`),
  ],
);
