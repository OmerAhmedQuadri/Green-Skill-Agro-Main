import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, numeric, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { id, timestamptz } from './columns';
import { users } from './identity';

/**
 * Values that differ from the settings register in packages/core (ADR-0024).
 * A key absent here takes its declared default.
 */
export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id),
});

/** SYS-005: system-wide switches; not permissions (PERMISSIONS §3.4). */
export const featureToggles = pgTable('feature_toggles', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id),
});

export const ceilingKind = pgEnum('ceiling_kind', ['CASH_IN_HAND', 'VEHICLE_STOCK_VALUE']);

/**
 * LIM-001: a global ceiling (seller_id null) and per-seller ceilings, which
 * take precedence (OQ-005). A breach warns; it never blocks (LIM-005).
 */
export const ceilings = pgTable(
  'ceilings',
  {
    id: id(),
    kind: ceilingKind('kind').notNull(),
    sellerId: uuid('seller_id').references(() => users.id),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id),
  },
  (t) => [
    unique('ceilings_kind_seller_unique').on(t.kind, t.sellerId).nullsNotDistinct(),
    index('ceilings_seller_id_idx').on(t.sellerId),
    check('ceilings_amount_positive', sql`${t.amount} > 0`),
  ],
);

/** SYS-008: each seller's commission rates, on target and below target (TGT, M11). */
export const commissionRates = pgTable(
  'commission_rates',
  {
    sellerId: uuid('seller_id').primaryKey().references(() => users.id),
    onTargetPercent: numeric('on_target_percent', { precision: 6, scale: 3 }).notNull(),
    belowTargetPercent: numeric('below_target_percent', { precision: 6, scale: 3 }).notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id),
  },
  (t) => [
    check('commission_rates_on_target_range', sql`${t.onTargetPercent} between 0 and 100`),
    check('commission_rates_below_target_range', sql`${t.belowTargetPercent} between 0 and 100`),
  ],
);
