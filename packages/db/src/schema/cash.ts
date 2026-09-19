import { sql } from 'drizzle-orm';
import { check, date, index, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { mediaAssets } from './media';
import { mutable } from './mutable';
import { branches } from './organisation';
import { cashLedgerEntries } from './sales';

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

// Mirror packages/core/src/cash/settlements.
export const settlementRoute = pgEnum('settlement_route', ['BANK_DEPOSIT', 'MANAGER_HANDOVER']);
export const settlementStatus = pgEnum('settlement_status', ['SUBMITTED', 'APPROVED', 'REJECTED']);
export const ceilingKindFlag = pgEnum('ceiling_flag_kind', ['CASH_IN_HAND', 'VEHICLE_STOCK_VALUE']);

/**
 * CSH-002..006, STATE-MACHINES §6, ADR-0040: cash leaving a seller's hands —
 * banked or handed to a manager, with its photo. Nothing moves in the cash
 * ledger until a manager approves, and both figures are kept when they differ.
 */
export const cashSettlements = pgTable(
  'cash_settlements',
  {
    id: id(),
    number: text('number').notNull().unique(),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    route: settlementRoute('route').notNull(),
    status: settlementStatus('status').notNull().default('SUBMITTED'),
    declaredAmount: money('declared_amount').notNull(),
    /** CSH-002: the day it was paid in. */ depositedOn: date('deposited_on'),
    /** CSH-003: the manager taking the cash. */ receivedBy: uuid('received_by').references(() => users.id),
    photoId: uuid('photo_id').notNull().references(() => mediaAssets.id),
    note: text('note'),
    submittedAt: timestamptz('submitted_at').notNull(),
    approvedAmount: money('approved_amount'),
    decidedAt: timestamptz('decided_at'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decisionComment: text('decision_comment'),
    /** CSH-005: written only on approval. */ cashLedgerEntryId: uuid('cash_ledger_entry_id').references(() => cashLedgerEntries.id),
    discrepancyEntryId: uuid('discrepancy_entry_id').references(() => cashLedgerEntries.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    index('cash_settlements_seller_id_idx').on(t.sellerId),
    index('cash_settlements_status_idx').on(t.status),
    index('cash_settlements_received_by_idx').on(t.receivedBy),
    index('cash_settlements_decided_by_idx').on(t.decidedBy),
    index('cash_settlements_photo_id_idx').on(t.photoId),
    index('cash_settlements_cash_ledger_entry_id_idx').on(t.cashLedgerEntryId),
    index('cash_settlements_discrepancy_entry_id_idx').on(t.discrepancyEntryId),
    check('cash_settlements_declared_positive', sql`${t.declaredAmount} > 0`),
    check('cash_settlements_route', sql`(${t.route} = 'BANK_DEPOSIT') = (${t.depositedOn} is not null)`),
    check('cash_settlements_handover', sql`(${t.route} = 'MANAGER_HANDOVER') = (${t.receivedBy} is not null)`),
    check('cash_settlements_decided', sql`(${t.status} = 'SUBMITTED') = (${t.decidedAt} is null and ${t.decidedBy} is null)`),
    check('cash_settlements_approved', sql`(${t.status} = 'APPROVED') = (${t.approvedAmount} is not null and ${t.cashLedgerEntryId} is not null)`),
  ],
);

/**
 * LIM-004, ADR-0040: a breach the management dashboard shows until it clears.
 * One open flag per seller and kind; the worker raises, reminds and clears it.
 */
export const dashboardFlags = pgTable(
  'dashboard_flags',
  {
    id: id(),
    kind: ceilingKindFlag('kind').notNull(),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    amount: money('amount').notNull(),
    ceiling: money('ceiling').notNull(),
    openedAt: timestamptz('opened_at').notNull(),
    lastNotifiedAt: timestamptz('last_notified_at').notNull(),
    /** LIM-003: how many repeats have gone out; from the second, managers hear too (OQ-021). */
    remindersSent: numeric('reminders_sent', { precision: 5, scale: 0 }).notNull().default('0'),
    resolvedAt: timestamptz('resolved_at'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dashboard_flags_one_open').on(t.kind, t.sellerId).where(sql`${t.resolvedAt} is null`),
    index('dashboard_flags_seller_id_idx').on(t.sellerId),
    check('dashboard_flags_amounts_positive', sql`${t.amount} > 0 and ${t.ceiling} > 0`),
  ],
);
