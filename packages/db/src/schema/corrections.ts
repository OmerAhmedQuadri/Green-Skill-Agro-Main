import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamptz } from './columns';
import { users } from './identity';
import { mutable } from './mutable';
import { branches } from './organisation';

// Mirror packages/core/src/corrections.
export const correctionClosing = pgEnum('correction_closing', ['KEPT', 'ADDED', 'EDITED']);

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
