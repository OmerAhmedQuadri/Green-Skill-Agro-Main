import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn, boolean, check, index, integer, pgEnum, pgTable, primaryKey, text, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz, version } from './columns';
import { branches } from './organisation';

export const userRole = pgEnum('user_role', ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SELLER']);
export const userStatus = pgEnum('user_status', ['ACTIVE', 'DEACTIVATED']);
export const locale = pgEnum('locale', ['en', 'ar']);

/** Accounts are provisioned, never self-registered (ADR-0018). */
export const users = pgTable(
  'users',
  {
    id: id(),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    role: userRole('role').notNull(),
    name: text('name').notNull(),
    email: text('email'), // lower-cased
    phone: text('phone'), // E.164
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    status: userStatus('status').notNull().default('ACTIVE'),
    locale: locale('locale').notNull().default('en'),
    failedSignIns: integer('failed_sign_ins').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),
    createdAt: createdAt(),
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by').references((): AnyPgColumn => users.id),
    version: version(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    uniqueIndex('users_phone_unique').on(t.phone),
    index('users_branch_id_idx').on(t.branchId),
    check('users_has_sign_in_identifier', sql`${t.email} is not null or ${t.phone} is not null`),
    check('users_email_lower_case', sql`${t.email} = lower(${t.email})`),
  ],
);

/** The cookie holds a random token; only its HMAC is stored (ADR-0018). */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId), index('sessions_expires_at_idx').on(t.expiresAt)],
);

/** Synced from the core catalogue on every deploy — the FK target for grants. */
export const permissions = pgTable('permissions', {
  code: text('code').primaryKey(),
  module: text('module').notNull(),
});

/** Per-user grants and withdrawals of configurable permissions (PERMISSIONS §1). */
export const userPermissions = pgTable(
  'user_permissions',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull().references(() => permissions.code, { onDelete: 'cascade' }),
    granted: boolean('granted').notNull(),
    grantedBy: uuid('granted_by').notNull().references(() => users.id),
    grantedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.permission] })],
);

export const permissionPresets = pgTable('permission_presets', {
  code: text('code').primaryKey(),
  isSystem: boolean('is_system').notNull().default(false),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const permissionPresetGrants = pgTable(
  'permission_preset_grants',
  {
    presetCode: text('preset_code').notNull().references(() => permissionPresets.code, { onDelete: 'cascade' }),
    permission: text('permission').notNull().references(() => permissions.code, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.presetCode, t.permission] })],
);
