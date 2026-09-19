import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { locale, users } from './identity';
import { branches } from './organisation';

export const emailStatus = pgEnum('email_status', ['PENDING', 'SENT', 'FAILED']);

/**
 * Transactional outbox (ADR-0023): a row is written in the same transaction as
 * the change that causes the email, and the worker delivers it. A rolled-back
 * change never sends; a delivered email leaves a record.
 */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: id(),
    toAddress: text('to_address').notNull(),
    template: text('template').notNull(),
    locale: locale('locale').notNull(),
    params: jsonb('params').notNull(),
    status: emailStatus('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: createdAt(),
    sentAt: timestamptz('sent_at'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
  },
  (t) => [index('email_outbox_due_idx').on(t.status, t.nextAttemptAt)],
);

/** Single-use, 30-minute password-reset tokens; only an HMAC is stored (ADR-0018). */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    requestedIp: text('requested_ip'),
  },
  (t) => [index('password_reset_tokens_user_id_idx').on(t.userId)],
);

// Mirror packages/core/src/notifications/index.ts.
export const notificationKind = pgEnum('notification_kind', [
  'LOAD_ISSUED', 'LOAD_DISPUTED', 'LOAD_CONFIRMED', 'LOAD_CANCELLED',
  'HANDOVER_PROPOSED', 'HANDOVER_COMPLETED',
  'CHECK_IN_AWAITING_AUTHORISATION', 'CHECK_IN_AUTHORISED', 'DAY_OPENED_ON_BEHALF',
  'CLOSING_VARIANCE', 'VEHICLE_RETURN_RECORDED',
]);

/**
 * In-app notifications (ADR-0034): a kind and its parameters, never text —
 * the client renders them in the reader's language. Written in the same
 * transaction as the event; polled every 30 s.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id),
    kind: notificationKind('kind').notNull(),
    params: jsonb('params').notNull(),
    link: text('link'),
    createdAt: createdAt(),
    readAt: timestamptz('read_at'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
  },
  (t) => [
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
    index('notifications_unread_idx').on(t.userId).where(sql`${t.readAt} is null`),
  ],
);
