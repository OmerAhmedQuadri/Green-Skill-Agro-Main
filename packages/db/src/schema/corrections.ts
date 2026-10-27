import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { mutable } from './mutable';
import { branches } from './organisation';
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
    check('store_corrections_reason', sql`length(btrim(${t.reason})) > 0`),
    check('store_corrections_payment', sql`(${t.kind} = 'PAYMENT') = (${t.originalPaymentId} is not null)`),
    check('store_corrections_moved', sql`${t.toStoreId} is null or (${t.after} is not null and ${t.toStoreId} <> ${t.storeId})`),
    check('store_corrections_cash', sql`not ${t.cashInHand} or ${t.kind} = 'PAYMENT'`),
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
