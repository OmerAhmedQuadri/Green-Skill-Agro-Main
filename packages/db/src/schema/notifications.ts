import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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
  'STORE_PENDING_APPROVAL', 'STORE_APPROVED', 'STORE_REJECTED', 'STORE_ASSIGNED', 'CREDIT_OVERRIDE_GRANTED',
  'DISCOUNT_APPROVAL_REQUESTED', 'DISCOUNT_APPROVED', 'DISCOUNT_REDUCED', 'DISCOUNT_REJECTED', 'DISCOUNT_EXPIRED',
  'DISPATCH_REQUESTED', 'DISPATCH_CREATED_FOR_YOU', 'DISPATCH_RELEASED', 'DISPATCH_CANCELLED', 'LOST_CLAIM_RAISED', 'LOST_CLAIM_DECIDED',
  'SETTLEMENT_SUBMITTED', 'SETTLEMENT_APPROVED', 'SETTLEMENT_REJECTED', 'CEILING_BREACHED',
  'TRANSFER_RECORDED', 'TRANSFER_NOT_RECEIVED',
  'TARGET_SET', 'TARGET_BEHIND_PACE', 'TARGET_MISSED', 'PERIOD_CLOSED',
]);

// Mirror REQUEST_OUTCOMES in packages/core/src/notifications/index.ts.
export const requestOutcome = pgEnum('request_outcome', [
  'APPROVED', 'REDUCED', 'REJECTED', 'CONFIRMED', 'NOT_RECEIVED', 'REVIEWED', 'AUTHORISED',
  'TAKEN', 'RELEASED', 'CANCELLED', 'EXPIRED', 'WITHDRAWN',
]);

/**
 * In-app notifications (ADR-0034): a kind and its parameters, never text —
 * the client renders them in the reader's language. Written in the same
 * transaction as the event; polled every 30 s.
 *
 * ADR-0051: a request goes to everyone who can act on it, one row each. Every
 * row names what it is about, and when the request ends they all record how,
 * when and by whom — and stop counting as unread.
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
    /** A request's record: the store, sale, settlement, payment, declaration, session or dispatch order. */
    subjectId: uuid('subject_id'),
    resolvedAt: timestamptz('resolved_at'),
    /** Null when nobody did it: a request that expired, a check-in withdrawn when its day closed. */
    resolvedBy: uuid('resolved_by').references(() => users.id),
    outcome: requestOutcome('outcome'),
  },
  (t) => [
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
    index('notifications_unread_idx').on(t.userId).where(sql`${t.readAt} is null and ${t.resolvedAt} is null`),
    index('notifications_subject_idx').on(t.subjectId).where(sql`${t.subjectId} is not null`),
    check('notifications_resolution', sql`(${t.resolvedAt} is null) = (${t.outcome} is null) and (${t.resolvedBy} is null or ${t.resolvedAt} is not null)`),
    check('notifications_resolved_subject', sql`${t.resolvedAt} is null or ${t.subjectId} is not null`),
  ],
);
