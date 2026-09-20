import { sql } from 'drizzle-orm';
import {
  boolean, check, foreignKey, index, integer, numeric, pgEnum, pgTable, primaryKey, text, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { id } from './columns';
import { mutable } from './mutable';
import { vendors } from './vendors';

// These mirror packages/core/src/catalogue; a services test keeps them in step.
export const countUnit = pgEnum('count_unit', ['SEED', 'PIECE']);
export const productAttribute = pgEnum('product_attribute', [
  'VARIETY', 'HYBRID', 'COUNTRY_OF_ORIGIN', 'VENDOR', 'LOT_NUMBER', 'MANUFACTURING_DATE', 'EXPIRY', 'SHELF_LIFE',
]);
export const attributeMode = pgEnum('attribute_mode', ['HIDDEN', 'OPTIONAL', 'REQUIRED']);
export const hybridClass = pgEnum('hybrid_class', ['HYBRID', 'NON_HYBRID']);
export const skuMeasure = pgEnum('sku_measure', ['WEIGHT', 'COUNT']);
export const packagingType = pgEnum('packaging_type', ['CAN', 'POUCH', 'BAG']);

/** CAT-013/014: each product type's attribute template decides the product form. */
export const productTypes = pgTable(
  'product_types',
  {
    id: id(),
    code: text('code').notNull().unique(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    countUnit: countUnit('count_unit').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...mutable(),
  },
  (t) => [uniqueIndex('product_types_name_en_unique').on(sql`lower(${t.nameEn})`)],
);

export const productTypeAttributes = pgTable(
  'product_type_attributes',
  {
    productTypeId: uuid('product_type_id').notNull().references(() => productTypes.id, { onDelete: 'cascade' }),
    attribute: productAttribute('attribute').notNull(),
    mode: attributeMode('mode').notNull(),
  },
  (t) => [primaryKey({ columns: [t.productTypeId, t.attribute] })],
);

/** CAT-001/002: maintained by the Admin in the application, not fixed in software. */
export const categories = pgTable(
  'categories',
  {
    id: id(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    expiryWarningDays: integer('expiry_warning_days'), // EXP-001; null → the system default
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...mutable(),
  },
  (t) => [
    uniqueIndex('categories_name_en_unique').on(sql`lower(${t.nameEn})`),
    check('categories_expiry_warning_days_range', sql`${t.expiryWarningDays} between 1 and 730`),
  ],
);

export const subCategories = pgTable(
  'sub_categories',
  {
    id: id(),
    categoryId: uuid('category_id').notNull().references(() => categories.id),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...mutable(),
  },
  (t) => [
    uniqueIndex('sub_categories_name_en_unique').on(t.categoryId, sql`lower(${t.nameEn})`),
    // The target of products' composite key: a sub-category always belongs to the product's category.
    unique('sub_categories_id_category_unique').on(t.id, t.categoryId),
  ],
);

/** CAT-004/005. Names are data in both languages (I18N-003). */
export const products = pgTable(
  'products',
  {
    id: id(),
    productTypeId: uuid('product_type_id').notNull().references(() => productTypes.id),
    categoryId: uuid('category_id').notNull().references(() => categories.id),
    subCategoryId: uuid('sub_category_id').notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    hybrid: hybridClass('hybrid'),
    countryOfOrigin: text('country_of_origin'), // ISO 3166-1 alpha-2
    vendorId: uuid('vendor_id').references(() => vendors.id), // VEN-004
    shelfLifeMonths: integer('shelf_life_months'), // CAT-017
    isActive: boolean('is_active').notNull().default(true),
    ...mutable(),
  },
  (t) => [
    foreignKey({ name: 'products_sub_category_fk', columns: [t.subCategoryId, t.categoryId], foreignColumns: [subCategories.id, subCategories.categoryId] }),
    uniqueIndex('products_name_en_unique').on(t.subCategoryId, sql`lower(${t.nameEn})`),
    index('products_product_type_id_idx').on(t.productTypeId),
    index('products_category_id_idx').on(t.categoryId),
    index('products_vendor_id_idx').on(t.vendorId),
    check('products_country_iso', sql`${t.countryOfOrigin} ~ '^[A-Z]{2}$'`),
    check('products_shelf_life_range', sql`${t.shelfLifeMonths} between 1 and 240`),
  ],
);

export const varieties = pgTable(
  'varieties',
  {
    id: id(),
    productId: uuid('product_id').notNull().references(() => products.id),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...mutable(),
  },
  (t) => [
    uniqueIndex('varieties_name_en_unique').on(t.productId, sql`lower(${t.nameEn})`),
    unique('varieties_id_product_unique').on(t.id, t.productId),
  ],
);

/**
 * CAT-006..012, DATA-MODEL §5.1: a SKU is sized by weight **or** by count, and
 * its pack size is fixed for life — stock is stored in its base units
 * (ADR-0015), so changing the size would silently rescale every movement.
 */
export const skus = pgTable(
  'skus',
  {
    id: id(),
    productId: uuid('product_id').notNull().references(() => products.id),
    varietyId: uuid('variety_id'), // null where the product type has no varieties
    code: text('code').notNull().unique(),
    codeOverridden: boolean('code_overridden').notNull().default(false), // CAT-008
    measure: skuMeasure('measure').notNull(),
    packWeightG: numeric('pack_weight_g', { precision: 12, scale: 3 }),
    packCount: integer('pack_count'),
    packaging: packagingType('packaging').notNull(),
    /**
     * RPT-004, OQ-023: the cushion the reorder projection keeps, in days of
     * cover rather than a pack quantity, so it follows demand instead of going
     * stale. Null means this SKU is not forecast.
     */
    safetyCoverDays: integer('safety_cover_days'),
    isActive: boolean('is_active').notNull().default(true),
    ...mutable(),
  },
  (t) => [
    check('skus_safety_cover_days_positive', sql`${t.safetyCoverDays} is null or ${t.safetyCoverDays} > 0`),
    foreignKey({ name: 'skus_variety_fk', columns: [t.varietyId, t.productId], foreignColumns: [varieties.id, varieties.productId] }),
    unique('skus_physical_identity').on(t.productId, t.varietyId, t.packaging, t.packWeightG, t.packCount).nullsNotDistinct(),
    index('skus_variety_id_idx').on(t.varietyId),
    check('skus_pack_size_union', sql`(
      ${t.measure} = 'WEIGHT' and ${t.packWeightG} is not null and ${t.packCount} is null and ${t.packWeightG} >= 0.1
    ) or (
      ${t.measure} = 'COUNT' and ${t.packCount} is not null and ${t.packWeightG} is null and ${t.packCount} > 0
    )`),
  ],
);
