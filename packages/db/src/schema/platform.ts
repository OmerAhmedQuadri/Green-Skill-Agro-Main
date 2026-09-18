import { index, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { branches } from './organisation';

/**
 * Who did what, when (AUD-001). Append-only: UPDATE, DELETE and TRUNCATE are
 * revoked from the runtime role (ADR-0008).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    actorId: uuid('actor_id').references(() => users.id), // null for system jobs and unknown sign-in attempts
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    requestId: text('request_id'),
    ip: text('ip'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
  },
  (t) => [
    index('audit_log_occurred_at_idx').on(t.occurredAt),
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
    index('audit_log_actor_id_idx').on(t.actorId),
  ],
);

/**
 * Replay store for mutating requests (ADR-0009). The row is inserted in the
 * use case's transaction, so a concurrent duplicate blocks, then replays.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] }), index('idempotency_keys_created_at_idx').on(t.createdAt)],
);

/** Fixed-window counters, shared across web instances (SECURITY §1). */
export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  windowStart: timestamptz('window_start').notNull(),
});
