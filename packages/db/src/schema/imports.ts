import { sql } from 'drizzle-orm';
import { check, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { skus } from './catalogue';
import { createdAt, id, timestamptz } from './columns';
import { correctionSessions } from './corrections';
import { users } from './identity';
import { mutable } from './mutable';
import { branches } from './organisation';
import { importedPayments, stores } from './stores';

// Mirror packages/core/src/imports.
export const importBatchStatus = pgEnum('import_batch_status', ['LOADED', 'UNDONE']);
export const importWarningKind = pgEnum('import_warning_kind', [
  'VOUCHER_MISSING', 'VOUCHER_NOT_IN_BOOKS', 'NAME_JOINED_BY_GUESS', 'PAYMENT_NO_STORE', 'PAYMENT_HELD_BACK', 'NAMES_MAY_BE_ONE_STORE',
  'LINE_DOES_NOT_ADD_UP', 'LINE_NOT_IN_CATALOGUE', 'LINE_READ_AS_OTHER_PACK', 'DATE_DIFFERS_FROM_STATEMENT', 'RETURN_NOT_IMPORTED',
  'BALANCE_DIFFERS_FROM_STATEMENT',
]);
export const importWarningResolution = pgEnum('import_warning_resolution', ['KEPT', 'CORRECTED']);

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

/**
 * IMP-004 (ADR-0059): one run of the history import — who ran it, when, and from which files. Undone as a whole,
 * which leaves its records in place and marks them out of use.
 */
export const importBatches = pgTable(
  'import_batches',
  {
    id: id(),
    number: integer('number').notNull().generatedAlwaysAsIdentity(),
    status: importBatchStatus('status').notNull().default('LOADED'),
    /** [{ name, sha256, bytes }] — the files exactly as loaded. */
    files: jsonb('files').notNull(),
    note: text('note'),
    undoneAt: timestamptz('undone_at'),
    undoneBy: uuid('undone_by').references(() => users.id),
    undoReason: text('undo_reason'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    uniqueIndex('import_batches_number_unique').on(t.number),
    check('import_batches_files', sql`jsonb_typeof(${t.files}) = 'array' and jsonb_array_length(${t.files}) > 0`),
    check('import_batches_undone', sql`(${t.status} = 'UNDONE') = (${t.undoneAt} is not null)
      and (${t.undoneAt} is null) = (${t.undoneBy} is null) and (${t.undoneAt} is null) = (${t.undoReason} is null)`),
  ],
);

/**
 * IMP-001: one invoice of a seller's book, as written — recorded, never posted at import. Its debit goes into the
 * store's account when the seller re-verifies the store (IMP-005), referencing it as IMPORTED_SALE. Append-only.
 */
export const importedSales = pgTable(
  'imported_sales',
  {
    id: id(),
    batchId: uuid('batch_id').notNull().references(() => importBatches.id),
    storeId: uuid('store_id').notNull().references(() => stores.id),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    soldOn: date('sold_on').notNull(),
    /** IMP-003: where it was written — the book, its row and the invoice's serial in it. */
    book: text('book').notNull(),
    bookRow: integer('book_row').notNull(),
    serial: integer('serial').notNull(),
    storeNameWritten: text('store_name_written').notNull(),
    subtotal: money('subtotal').notNull(),
    discount: money('discount').notNull().default('0'),
    total: money('total').notNull(),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
  },
  (t) => [
    uniqueIndex('imported_sales_serial_unique').on(t.batchId, t.sellerId, t.serial),
    index('imported_sales_store_id_idx').on(t.storeId),
    index('imported_sales_seller_id_idx').on(t.sellerId),
    check('imported_sales_discount', sql`${t.discount} >= 0`),
    check('imported_sales_total', sql`${t.total} > 0 and ${t.total} = ${t.subtotal} - ${t.discount}`),
    check('imported_sales_where', sql`${t.bookRow} > 0 and ${t.serial} > 0`),
  ],
);

/**
 * IMP-001: a line of an imported sale, as written. The amount is kept even where packs × price differ — it is what
 * the store was charged (ADR-0059). Packs as written, not base units: these lines never touch stock (IMP-006).
 */
export const importedSaleLines = pgTable(
  'imported_sale_lines',
  {
    id: id(),
    importedSaleId: uuid('imported_sale_id').notNull().references(() => importedSales.id),
    lineNo: integer('line_no').notNull(),
    itemWritten: text('item_written').notNull(),
    packWritten: text('pack_written'),
    /** The catalogue SKU the line names, where one matches; otherwise the line keeps only its words. */
    skuId: uuid('sku_id').references(() => skus.id),
    packs: numeric('packs', { precision: 12, scale: 3 }).notNull(),
    unitPrice: money('unit_price').notNull(),
    amount: money('amount').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('imported_sale_lines_line_unique').on(t.importedSaleId, t.lineNo),
    index('imported_sale_lines_sku_id_idx').on(t.skuId),
    check('imported_sale_lines_figures', sql`${t.lineNo} > 0 and ${t.packs} > 0 and ${t.unitPrice} >= 0 and ${t.amount} >= 0`),
  ],
);

/**
 * IMP-009 (ADR-0059): what the import could not settle, about one store, imported sale or imported payment, with the
 * figures that explain it. The Super Admin keeps it as it is, with a note, or marks it corrected in a correction
 * session — once; only those columns may change (migration 0035).
 */
export const importWarnings = pgTable(
  'import_warnings',
  {
    id: id(),
    batchId: uuid('batch_id').notNull().references(() => importBatches.id),
    kind: importWarningKind('kind').notNull(),
    storeId: uuid('store_id').references(() => stores.id),
    importedSaleId: uuid('imported_sale_id').references(() => importedSales.id),
    importedPaymentId: uuid('imported_payment_id').references((): AnyPgColumn => importedPayments.id),
    params: jsonb('params').notNull().default({}),
    resolution: importWarningResolution('resolution'),
    resolutionNote: text('resolution_note'),
    /** The correction session a warning was marked corrected in. */
    sessionId: uuid('session_id').references((): AnyPgColumn => correctionSessions.id),
    resolvedAt: timestamptz('resolved_at'),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
  },
  (t) => [
    index('import_warnings_batch_id_idx').on(t.batchId),
    index('import_warnings_store_id_idx').on(t.storeId),
    index('import_warnings_imported_sale_id_idx').on(t.importedSaleId),
    index('import_warnings_imported_payment_id_idx').on(t.importedPaymentId),
    index('import_warnings_session_id_idx').on(t.sessionId),
    index('import_warnings_open_idx').on(t.batchId).where(sql`${t.resolution} is null`),
    check('import_warnings_subject', sql`num_nonnulls(${t.storeId}, ${t.importedSaleId}, ${t.importedPaymentId}) = 1`),
    check('import_warnings_resolved', sql`(${t.resolution} is null) = (${t.resolvedAt} is null)
      and (${t.resolution} is null) = (${t.resolvedBy} is null)
      and (${t.resolution} is null) = (length(btrim(coalesce(${t.resolutionNote}, ''))) = 0)`),
    check('import_warnings_corrected', sql`coalesce(${t.resolution} = 'CORRECTED', false) = (${t.sessionId} is not null)`),
  ],
);
