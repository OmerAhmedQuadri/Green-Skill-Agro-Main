import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { skus } from './catalogue';
import { id, timestamptz } from './columns';
import { users } from './identity';
import { branches } from './organisation';
import { stores } from './stores';

/**
 * RPT-001, RPT-002 (ADR-0043): what sold, by day and SKU, with the seller and
 * store that sold it. Filled nightly and rebuilt from the sales themselves, so
 * it is derived data — never a source of truth, and always safe to drop.
 *
 * A trend that is a day stale is fine. A stock figure that is stale is not, and
 * comes from the ledger instead (DATA-MODEL §6).
 */
export const salesDailyRollup = pgTable(
  'sales_daily_rollup',
  {
    id: id(),
    /** The Riyadh business day the sale completed on. */
    day: date('day').notNull(),
    skuId: uuid('sku_id').notNull().references(() => skus.id),
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    storeId: uuid('store_id').notNull().references(() => stores.id),
    packs: integer('packs').notNull(),
    revenue: numeric('revenue', { precision: 14, scale: 2 }).notNull(),
    /** RET-009: packs and value that came back, netted off in the month raised. */
    returnedPacks: integer('returned_packs').notNull().default(0),
    returnedValue: numeric('returned_value', { precision: 14, scale: 2 }).notNull().default('0.00'),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    builtAt: timestamptz('built_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sales_daily_rollup_unique').on(t.day, t.skuId, t.sellerId, t.storeId),
    index('sales_daily_rollup_day_idx').on(t.day),
    index('sales_daily_rollup_sku_day_idx').on(t.skuId, t.day),
    index('sales_daily_rollup_seller_idx').on(t.sellerId, t.day),
    index('sales_daily_rollup_store_idx').on(t.storeId, t.day),
  ],
);

/**
 * RPT-004..006, PO-008 (ADR-0043): the nightly reorder pass — what the
 * projection says, and the workings behind it, for a manager to accept, change
 * or ignore. Advisory only: RPT-005 is explicit that the system never places an
 * order, so nothing here becomes a purchase order without someone saying so.
 */
export const reorderRecommendations = pgTable(
  'reorder_recommendations',
  {
    id: id(),
    builtAt: timestamptz('built_at').notNull(),
    skuId: uuid('sku_id').notNull().references(() => skus.id),
    onHand: integer('on_hand').notNull(),
    inTransit: integer('in_transit').notNull(),
    /** Packs a day at the basis used. */
    perDay: numeric('per_day', { precision: 12, scale: 3 }).notNull(),
    basisUsed: text('basis_used').notNull(),
    /** RPT-011: no season of history stands behind this figure. */
    guide: boolean('guide').notNull().default(false),
    leadTimeDays: integer('lead_time_days').notNull(),
    safetyCoverDays: integer('safety_cover_days').notNull(),
    projectedAtArrival: integer('projected_at_arrival').notNull(),
    safetyLevel: integer('safety_level').notNull(),
    suggestedPacks: integer('suggested_packs').notNull(),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
  },
  (t) => [
    uniqueIndex('reorder_recommendations_sku_built_unique').on(t.skuId, t.builtAt),
    index('reorder_recommendations_built_idx').on(t.builtAt),
    check('reorder_recommendations_basis', sql`${t.basisUsed} in ('TRAILING', 'SEASONAL')`),
    check('reorder_recommendations_suggested', sql`${t.suggestedPacks} >= 0`),
  ],
);
