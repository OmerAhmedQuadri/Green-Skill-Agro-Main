import { sql } from 'drizzle-orm';
import { boolean, check, index, numeric, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { skus } from './catalogue';
import { id, timestamptz } from './columns';
import { users } from './identity';
import { mutable } from './mutable';

/**
 * PRC-002/003: one base list applies to every store; additional lists override
 * it for the stores assigned to them (from M5).
 */
export const priceLists = pgTable(
  'price_lists',
  {
    id: id(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    isBase: boolean('is_base').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...mutable(),
  },
  (t) => [
    uniqueIndex('price_lists_name_en_unique').on(sql`lower(${t.nameEn})`),
    uniqueIndex('price_lists_single_base').on(t.isBase).where(sql`${t.isBase}`),
  ],
);

/** PRC-001: prices are per SKU, per pack. Sales copy the price, so edits never rewrite history. */
export const priceListItems = pgTable(
  'price_list_items',
  {
    priceListId: uuid('price_list_id').notNull().references(() => priceLists.id),
    skuId: uuid('sku_id').notNull().references(() => skus.id),
    price: numeric('price', { precision: 14, scale: 2 }).notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id),
  },
  (t) => [
    primaryKey({ columns: [t.priceListId, t.skuId] }),
    index('price_list_items_sku_id_idx').on(t.skuId),
    check('price_list_items_price_positive', sql`${t.price} > 0`),
  ],
);

/** PRC-005: an item's own discount ceiling, where it differs from the default item ceiling. */
export const skuDiscountCeilings = pgTable(
  'sku_discount_ceilings',
  {
    skuId: uuid('sku_id').primaryKey().references(() => skus.id),
    ceiling: numeric('ceiling', { precision: 6, scale: 3 }).notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id),
  },
  (t) => [check('sku_discount_ceilings_range', sql`${t.ceiling} between 0 and 100`)],
);
