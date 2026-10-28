import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, numeric, pgEnum, pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { mutable } from './mutable';
import { branches } from './organisation';
import { importedSales } from './imports';
import { deliveryDocuments, sales, saleLines } from './sales';
import { batches } from './stock';
import { importedPayments, payments, storeLedgerEntries, stores } from './stores';

// Mirror packages/core/src/corrections.
export const correctionClosing = pgEnum('correction_closing', ['KEPT', 'ADDED', 'EDITED']);
export const storeCorrectionKind = pgEnum('store_correction_kind', ['BILL', 'PAYMENT']);

/**
 * COR-001, COR-003 (ADR-0059): a Super Admin's personal correction session — opened with their password and a
 * reason, ended after an hour or when closed, and closed by settling the reason. Who opened it, when and why can
 * never change: the app may update only the closing columns (migration 0031).
 */
export const correctionSessions = pgTable(
  'correction_sessions',
  {
    id: id(),
    number: integer('number').notNull().generatedAlwaysAsIdentity(),
    openedBy: uuid('opened_by').notNull().references(() => users.id),
    openedAt: timestamptz('opened_at').notNull(),
    endsAt: timestamptz('ends_at').notNull(),
    reason: text('reason').notNull(),
    closedAt: timestamptz('closed_at'),
    /** When it stopped: when it was closed, or the end of its hour if that came first. */
    endedAt: timestamptz('ended_at'),
    closing: correctionClosing('closing'),
    /** The words added to the reason, or the edited reason; the original stays in `reason`. */
    closingText: text('closing_text'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    uniqueIndex('correction_sessions_number_unique').on(t.number),
    // One session at a time for each Super Admin, until its reason is settled.
    uniqueIndex('correction_sessions_one_unsettled').on(t.openedBy).where(sql`${t.closedAt} is null`),
    index('correction_sessions_opened_by_idx').on(t.openedBy),
    index('correction_sessions_opened_at_idx').on(t.openedAt),
    check('correction_sessions_hour', sql`${t.endsAt} = ${t.openedAt} + interval '1 hour'`),
    check('correction_sessions_reason', sql`length(btrim(${t.reason})) > 0`),
    check('correction_sessions_closed', sql`(${t.closedAt} is null) = (${t.endedAt} is null)
      and (${t.closedAt} is null) = (${t.closing} is null)
      and (${t.endedAt} is null or (${t.endedAt} >= ${t.openedAt} and ${t.endedAt} <= ${t.endsAt} and ${t.endedAt} <= ${t.closedAt}))`),
    check('correction_sessions_closing_text', sql`case when ${t.closing} in ('ADDED', 'EDITED')
      then length(btrim(coalesce(${t.closingText}, ''))) > 0 else ${t.closingText} is null end`),
  ],
);

/**
 * COR-002, COR-005 (ADR-0059): one correction of a store's account, made in its Super Admin's session with a reason
 * of its own. It reverses the entry it corrects (entries referencing `CORRECTION_REVERSAL`) and posts the corrected
 * one — a bill referencing `CORRECTION`, a payment as a new `payments` row naming this correction. `before` and
 * `after` keep the values: { amount, date, storeId, voucherNumber }; `after` is null for a removal. Append-only.
 */
export const storeCorrections = pgTable(
  'store_corrections',
  {
    id: id(),
    number: integer('number').notNull().generatedAlwaysAsIdentity(),
    sessionId: uuid('session_id').notNull().references(() => correctionSessions.id),
    kind: storeCorrectionKind('kind').notNull(),
    storeId: uuid('store_id').notNull().references(() => stores.id),
    /** Where the corrected entry went, when it moved to another store. */
    toStoreId: uuid('to_store_id').references(() => stores.id),
    originalEntryId: uuid('original_entry_id').notNull().references((): AnyPgColumn => storeLedgerEntries.id),
    originalPaymentId: uuid('original_payment_id').references((): AnyPgColumn => payments.id),
    before: jsonb('before').notNull(),
    after: jsonb('after'),
    reason: text('reason').notNull(),
    /** The Super Admin chose to correct a cash payment's collector's cash in hand too. */
    cashInHand: boolean('cash_in_hand').notNull().default(false),
    /** COR-006: the bill of a sale made in the app, corrected through the sale — never from the account alone. */
    saleId: uuid('sale_id').references((): AnyPgColumn => sales.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
  },
  (t) => [
    uniqueIndex('store_corrections_number_unique').on(t.number),
    // An entry is corrected once; a later correction corrects the corrected entry.
    uniqueIndex('store_corrections_original_entry_unique').on(t.originalEntryId),
    index('store_corrections_session_id_idx').on(t.sessionId),
    index('store_corrections_store_id_idx').on(t.storeId),
    index('store_corrections_to_store_id_idx').on(t.toStoreId),
    index('store_corrections_original_payment_id_idx').on(t.originalPaymentId),
    index('store_corrections_sale_id_idx').on(t.saleId),
    check('store_corrections_reason', sql`length(btrim(${t.reason})) > 0`),
    check('store_corrections_payment', sql`(${t.kind} = 'PAYMENT') = (${t.originalPaymentId} is not null)`),
    check('store_corrections_moved', sql`${t.toStoreId} is null or (${t.after} is not null and ${t.toStoreId} <> ${t.storeId})`),
    check('store_corrections_cash', sql`not ${t.cashInHand} or ${t.kind} = 'PAYMENT'`),
    check('store_corrections_sale', sql`${t.saleId} is null or ${t.kind} = 'BILL'`),
  ],
);

/**
 * COR-006 (ADR-0059, amended 28 October): one correction of a sale, in its Super Admin's session with a reason of its
 * own. `before` and `after` keep the sale's values — its store, its lines and its totals; `after` is null when the
 * sale was removed. Append-only.
 *
 * A sale made in the app keeps its corrected figures, and what it was stays here. What else follows is the Super
 * Admin's choice, and each is recorded: its stock (`sale_correction_allocations`, moved back to or out of the batch
 * and place each line was sold from), a new version of its delivery document, the bill in the store's account (a
 * store correction), and — for an open sale paid in cash — its seller's cash in hand.
 *
 * An imported sale's correction writes the corrected invoice (`imported_sales.correction_id`). Only the bill
 * follows, when it is in the account already: there is no stock and no delivery document.
 */
export const saleCorrections = pgTable(
  'sale_corrections',
  {
    id: id(),
    number: integer('number').notNull().generatedAlwaysAsIdentity(),
    sessionId: uuid('session_id').notNull().references(() => correctionSessions.id),
    saleId: uuid('sale_id').references((): AnyPgColumn => sales.id),
    importedSaleId: uuid('imported_sale_id').references((): AnyPgColumn => importedSales.id),
    before: jsonb('before').notNull(),
    after: jsonb('after'),
    reason: text('reason').notNull(),
    stock: boolean('stock').notNull().default(false),
    document: boolean('document').notNull().default(false),
    account: boolean('account').notNull().default(false),
    cashInHand: boolean('cash_in_hand').notNull().default(false),
    storeCorrectionId: uuid('store_correction_id').references((): AnyPgColumn => storeCorrections.id),
    documentId: uuid('document_id').references((): AnyPgColumn => deliveryDocuments.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
  },
  (t) => [
    uniqueIndex('sale_corrections_number_unique').on(t.number),
    index('sale_corrections_session_id_idx').on(t.sessionId),
    index('sale_corrections_sale_id_idx').on(t.saleId),
    index('sale_corrections_imported_sale_id_idx').on(t.importedSaleId),
    index('sale_corrections_store_correction_id_idx').on(t.storeCorrectionId),
    index('sale_corrections_document_id_idx').on(t.documentId),
    check('sale_corrections_reason', sql`length(btrim(${t.reason})) > 0`),
    check('sale_corrections_one_sale', sql`(${t.saleId} is null) <> (${t.importedSaleId} is null)`),
    check('sale_corrections_imported', sql`${t.importedSaleId} is null
      or (${t.after} is not null and not ${t.stock} and not ${t.document} and not ${t.cashInHand})`),
    check('sale_corrections_account', sql`${t.account} = (${t.storeCorrectionId} is not null)`),
    check('sale_corrections_document', sql`${t.document} = (${t.documentId} is not null)`),
  ],
);

/**
 * COR-006: the stock a sale correction moved, line by line and batch by batch — signed, as the sale's own
 * allocations would have changed: positive taken out (sold), negative given back. Append-only.
 */
export const saleCorrectionAllocations = pgTable(
  'sale_correction_allocations',
  {
    id: id(),
    correctionId: uuid('correction_id').notNull().references(() => saleCorrections.id),
    saleLineId: uuid('sale_line_id').notNull().references((): AnyPgColumn => saleLines.id),
    batchId: uuid('batch_id').notNull().references(() => batches.id),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
  },
  (t) => [
    uniqueIndex('sale_correction_allocations_unique').on(t.correctionId, t.saleLineId, t.batchId),
    index('sale_correction_allocations_sale_line_id_idx').on(t.saleLineId),
    index('sale_correction_allocations_batch_id_idx').on(t.batchId),
    check('sale_correction_allocations_quantity', sql`${t.quantity} <> 0`),
  ],
);

/**
 * COR-005, IMP-009 (ADR-0059): an imported payment nobody could place, attached to its store by a Super Admin in a
 * correction session. It goes into that store's account at re-verification, or at once if the store is verified
 * already. Append-only: a wrong attachment is corrected on the account (store corrections).
 */
export const importedPaymentAssignments = pgTable(
  'imported_payment_assignments',
  {
    id: id(),
    importedPaymentId: uuid('imported_payment_id').notNull().references((): AnyPgColumn => importedPayments.id),
    storeId: uuid('store_id').notNull().references(() => stores.id),
    sessionId: uuid('session_id').notNull().references(() => correctionSessions.id),
    reason: text('reason').notNull(),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
  },
  (t) => [
    uniqueIndex('imported_payment_assignments_payment_unique').on(t.importedPaymentId),
    index('imported_payment_assignments_store_id_idx').on(t.storeId),
    index('imported_payment_assignments_session_id_idx').on(t.sessionId),
    check('imported_payment_assignments_reason', sql`length(btrim(${t.reason})) > 0`),
  ],
);
