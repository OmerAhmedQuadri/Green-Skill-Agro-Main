import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamptz } from './columns';
import { users } from './identity';
import { mutable } from './mutable';
import { branches } from './organisation';

/**
 * TGT-001..003, ADR-0042: one seller's goals for one calendar month. Each of
 * the four figures is optional — a null is not a goal of zero, it is a figure
 * that is not part of that seller's month and is never shown as a bar to fill.
 */
export const sellerTargets = pgTable(
  'seller_targets',
  {
    id: id(),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    /** A Riyadh calendar month, `YYYY-MM` (TGT-002). */
    period: text('period').notNull(),
    revenue: numeric('revenue', { precision: 14, scale: 2 }),
    packsSold: integer('packs_sold'),
    newStores: integer('new_stores'),
    collected: numeric('collected', { precision: 14, scale: 2 }),
    note: text('note'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    ...mutable(),
  },
  (t) => [
    uniqueIndex('seller_targets_seller_period_unique').on(t.sellerId, t.period),
    index('seller_targets_period_idx').on(t.period),
    check('seller_targets_period_format', sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      'seller_targets_positive',
      sql`(${t.revenue} is null or ${t.revenue} > 0) and (${t.packsSold} is null or ${t.packsSold} > 0)
        and (${t.newStores} is null or ${t.newStores} > 0) and (${t.collected} is null or ${t.collected} > 0)`,
    ),
    // A target with nothing set would be met by doing nothing (TARGET_EMPTY in core).
    check(
      'seller_targets_not_empty',
      sql`num_nonnulls(${t.revenue}, ${t.packsSold}, ${t.newStores}, ${t.collected}) > 0`,
    ),
  ],
);

/**
 * COM-008, TGT-005, ADR-0042: the month as it stood when it froze — target,
 * actual, achievement, the rate applied and the commission. Written once, a few
 * days after the month ends, and never recalculated. Every later screen and
 * report reads this rather than recomputing, which is what makes a seller's
 * commission safe to pay against.
 */
export const commissionPeriods = pgTable(
  'commission_periods',
  {
    id: id(),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    period: text('period').notNull(),
    frozenAt: timestamptz('frozen_at').notNull(),
    /** The goals as they stood at the freeze; null where the seller had no target. */
    goals: jsonb('goals'),
    /** Every figure's actual and achievement, so the snapshot stands without the ledger. */
    progress: jsonb('progress').notNull(),
    /** TGT-005: false where a goal was set and missed; null where there was no target. */
    met: boolean('met'),
    /** Cash that reached the business and stayed there (COM-001, OQ-023). */
    base: numeric('base', { precision: 14, scale: 2 }).notNull(),
    ratePercent: numeric('rate_percent', { precision: 6, scale: 3 }),
    commission: numeric('commission', { precision: 14, scale: 2 }),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('commission_periods_seller_period_unique').on(t.sellerId, t.period),
    index('commission_periods_period_idx').on(t.period),
    check('commission_periods_period_format', sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('commission_periods_base_not_negative', sql`${t.base} >= 0`),
    check('commission_periods_rate_range', sql`${t.ratePercent} is null or ${t.ratePercent} between 0 and 100`),
    // A rate and a commission travel together: one without the other is a half-written snapshot.
    check('commission_periods_rate_with_commission', sql`(${t.ratePercent} is null) = (${t.commission} is null)`),
  ],
);
