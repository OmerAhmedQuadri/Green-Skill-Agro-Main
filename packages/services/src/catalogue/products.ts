import {
  applyTemplate, assertSkuVariety, bilingualName, countryCode, DomainError, generateSkuCode, normaliseSkuCode,
  packCountOf, packWeightGrams, price, resolveSkuCode,
  type CountUnit, type Hybrid, type Money, type PackSize, type Packaging, type ProductId, type SkuId,
  type Template, type VarietyId, type VendorId,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, exists, gt, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import {
  audit, decodeCursor, encodeCursor, inTx, likePattern, mapUniqueViolations, pageLimit, snapshot, type Executor,
} from '../platform';
import { getDb } from '../runtime';
import { CATALOGUE_READERS } from './access';
import { loadProductType } from './product-types';

const { products, varieties, skus, categories, subCategories, productTypes, vendors, priceLists, priceListItems } = schema;

type Named = { readonly id: string; readonly nameEn: string; readonly nameAr: string };

export type ProductSummary = {
  readonly id: ProductId;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly productType: Named;
  readonly category: Named;
  readonly subCategory: Named;
  readonly vendor: { readonly id: VendorId; readonly code: string } | null;
  readonly varietyCount: number;
  readonly skuCount: number;
  readonly isActive: boolean;
};

export type Variety = {
  readonly id: VarietyId; readonly nameEn: string; readonly nameAr: string; readonly isActive: boolean; readonly version: number;
};

export type Sku = {
  readonly id: SkuId;
  readonly varietyId: VarietyId | null;
  readonly code: string;
  readonly codeOverridden: boolean;
  readonly size: PackSize;
  readonly packaging: Packaging;
  readonly isActive: boolean;
  readonly version: number;
  /** On the base price list (PRC-002). Null until one is set. */
  readonly basePrice: Money | null;
};

export type ProductDetail = Omit<ProductSummary, 'productType' | 'varietyCount' | 'skuCount'> & {
  readonly productType: Named & { readonly countUnit: CountUnit; readonly template: Template };
  readonly hybrid: Hybrid | null;
  readonly countryOfOrigin: string | null;
  readonly shelfLifeMonths: number | null;
  readonly version: number;
  readonly varieties: readonly Variety[];
  readonly skus: readonly Sku[];
};

const duplicateProduct = new DomainError('DUPLICATE_NAME', { field: 'nameEn' });
const duplicateCode = new DomainError('DUPLICATE_CODE', { field: 'code' });
const duplicateSku = new DomainError('DUPLICATE_SKU');

// ---------------------------------------------------------------- queries

export async function listProducts(
  ctx: Ctx,
  filter: {
    search?: string | undefined; productTypeId?: string | undefined; categoryId?: string | undefined;
    subCategoryId?: string | undefined; vendorId?: string | undefined; isActive?: boolean | undefined;
    cursor?: string | undefined; limit?: number | undefined;
  } = {},
): Promise<{ items: ProductSummary[]; nextCursor: string | null }> {
  authorizeAny(ctx, CATALOGUE_READERS);
  const limit = pageLimit(filter.limit);
  // Sorted by name in the reader's language; the cursor carries the sort key and the id.
  const sortKey = ctx.locale === 'ar' ? products.nameAr : sql<string>`lower(${products.nameEn})`;
  const where: SQL[] = [];
  if (filter.productTypeId) where.push(eq(products.productTypeId, filter.productTypeId));
  if (filter.categoryId) where.push(eq(products.categoryId, filter.categoryId));
  if (filter.subCategoryId) where.push(eq(products.subCategoryId, filter.subCategoryId));
  if (filter.vendorId) where.push(eq(products.vendorId, filter.vendorId));
  if (filter.isActive !== undefined) where.push(eq(products.isActive, filter.isActive));
  if (filter.search) {
    const q = likePattern(filter.search);
    where.push(or(
      ilike(products.nameEn, q), ilike(products.nameAr, q),
      exists(getDb().select({ one: sql`1` }).from(skus).where(and(eq(skus.productId, products.id), ilike(skus.code, q)))),
      exists(getDb().select({ one: sql`1` }).from(varieties).where(and(eq(varieties.productId, products.id), or(ilike(varieties.nameEn, q), ilike(varieties.nameAr, q))))),
    ) as SQL);
  }
  if (filter.cursor) {
    const [key = '', id = ''] = decodeCursor(filter.cursor, 2);
    where.push(sql`(${sortKey}, ${products.id}) > (${key}, ${id})`);
  }

  const rows = await getDb()
    .select({
      id: products.id, nameEn: products.nameEn, nameAr: products.nameAr, isActive: products.isActive, sortKey,
      typeId: productTypes.id, typeEn: productTypes.nameEn, typeAr: productTypes.nameAr,
      categoryId: categories.id, categoryEn: categories.nameEn, categoryAr: categories.nameAr,
      subId: subCategories.id, subEn: subCategories.nameEn, subAr: subCategories.nameAr,
      vendorId: vendors.id, vendorCode: vendors.code,
      varietyCount: sql<number>`(select count(*)::int from ${varieties} where ${varieties.productId} = ${products.id})`,
      skuCount: sql<number>`(select count(*)::int from ${skus} where ${skus.productId} = ${products.id})`,
    })
    .from(products)
    .innerJoin(productTypes, eq(productTypes.id, products.productTypeId))
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .innerJoin(subCategories, eq(subCategories.id, products.subCategoryId))
    .leftJoin(vendors, eq(vendors.id, products.vendorId))
    .where(and(...where))
    .orderBy(asc(sortKey), asc(products.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id as ProductId, nameEn: r.nameEn, nameAr: r.nameAr, isActive: r.isActive,
      productType: { id: r.typeId, nameEn: r.typeEn, nameAr: r.typeAr },
      category: { id: r.categoryId, nameEn: r.categoryEn, nameAr: r.categoryAr },
      subCategory: { id: r.subId, nameEn: r.subEn, nameAr: r.subAr },
      vendor: r.vendorId && r.vendorCode ? { id: r.vendorId as VendorId, code: r.vendorCode } : null,
      varietyCount: r.varietyCount, skuCount: r.skuCount,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.sortKey, last.id]) : null,
  };
}

export async function getProduct(ctx: Ctx, id: string): Promise<ProductDetail> {
  authorizeAny(ctx, CATALOGUE_READERS);
  return loadProduct(getDb(), id);
}

export async function loadProduct(db: Executor, id: string): Promise<ProductDetail> {
  const [row] = await db
    .select({
      product: products,
      categoryEn: categories.nameEn, categoryAr: categories.nameAr,
      subEn: subCategories.nameEn, subAr: subCategories.nameAr,
      vendorCode: vendors.code,
    })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .innerJoin(subCategories, eq(subCategories.id, products.subCategoryId))
    .leftJoin(vendors, eq(vendors.id, products.vendorId))
    .where(eq(products.id, id));
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'product', id });
  const p = row.product;
  const type = await loadProductType(db, p.productTypeId);

  const [varietyRows, skuRows] = await Promise.all([
    db.select().from(varieties).where(eq(varieties.productId, id)).orderBy(asc(varieties.nameEn)),
    db.select({ sku: skus, basePrice: priceListItems.price })
      .from(skus)
      .leftJoin(priceLists, eq(priceLists.isBase, true))
      .leftJoin(priceListItems, and(eq(priceListItems.priceListId, priceLists.id), eq(priceListItems.skuId, skus.id)))
      .where(eq(skus.productId, id))
      .orderBy(asc(skus.code)),
  ]);

  return {
    id: p.id as ProductId, nameEn: p.nameEn, nameAr: p.nameAr, isActive: p.isActive, version: p.version,
    productType: { id: type.id, nameEn: type.nameEn, nameAr: type.nameAr, countUnit: type.countUnit, template: type.template },
    category: { id: p.categoryId, nameEn: row.categoryEn, nameAr: row.categoryAr },
    subCategory: { id: p.subCategoryId, nameEn: row.subEn, nameAr: row.subAr },
    // VEN-005: the code is always shown; the profile behind it needs vendors.view.
    vendor: p.vendorId && row.vendorCode ? { id: p.vendorId as VendorId, code: row.vendorCode } : null,
    hybrid: p.hybrid, countryOfOrigin: p.countryOfOrigin, shelfLifeMonths: p.shelfLifeMonths,
    varieties: varietyRows.map((v) => ({ id: v.id as VarietyId, nameEn: v.nameEn, nameAr: v.nameAr, isActive: v.isActive, version: v.version })),
    skus: skuRows.map(({ sku: s, basePrice }) => ({
      id: s.id as SkuId, varietyId: s.varietyId as VarietyId | null, code: s.code, codeOverridden: s.codeOverridden,
      size: sizeOf(s), packaging: s.packaging, isActive: s.isActive, version: s.version,
      basePrice: (basePrice ?? null) as Money | null,
    })),
  };
}

export function sizeOf(s: { measure: 'WEIGHT' | 'COUNT'; packWeightG: string | null; packCount: number | null }): PackSize {
  return s.measure === 'WEIGHT' ? { measure: 'WEIGHT', packWeightG: s.packWeightG ?? '0' } : { measure: 'COUNT', packCount: s.packCount ?? 0 };
}

// ---------------------------------------------------------------- products

type ProductFields = {
  categoryId: string; subCategoryId: string; nameEn: string; nameAr: string;
  hybrid?: Hybrid | null | undefined; countryOfOrigin?: string | null | undefined;
  vendorId?: string | null | undefined; shelfLifeMonths?: number | null | undefined;
};

/** The category and sub-category must exist, be active, and belong together (CAT-002). */
async function assertPlacement(db: Executor, categoryId: string, subCategoryId: string) {
  const [sub] = await db.select({ categoryId: subCategories.categoryId, subActive: subCategories.isActive, categoryActive: categories.isActive })
    .from(subCategories).innerJoin(categories, eq(categories.id, subCategories.categoryId))
    .where(eq(subCategories.id, subCategoryId));
  if (!sub || sub.categoryId !== categoryId) throw new DomainError('NOT_FOUND', { entity: 'sub_category', id: subCategoryId });
  if (!sub.subActive || !sub.categoryActive) throw new DomainError('REFERENCE_INACTIVE', { entity: 'sub_category', id: subCategoryId });
}

async function assertVendor(db: Executor, vendorId: string | null) {
  if (!vendorId) return;
  const [vendor] = await db.select({ isActive: vendors.isActive }).from(vendors).where(eq(vendors.id, vendorId));
  if (!vendor) throw new DomainError('NOT_FOUND', { entity: 'vendor', id: vendorId });
  if (!vendor.isActive) throw new DomainError('REFERENCE_INACTIVE', { entity: 'vendor', id: vendorId });
}

function attributesFor(template: Template, input: Partial<ProductFields>) {
  const shelfLife = input.shelfLifeMonths ?? null;
  if (shelfLife !== null && (!Number.isInteger(shelfLife) || shelfLife < 1 || shelfLife > 240)) {
    throw new DomainError('ATTRIBUTE_REQUIRED', { attribute: 'SHELF_LIFE' });
  }
  return applyTemplate(template, {
    hybrid: input.hybrid ?? null,
    countryOfOrigin: input.countryOfOrigin ? countryCode(input.countryOfOrigin) : null,
    vendorId: input.vendorId ?? null,
    shelfLifeMonths: shelfLife,
  });
}

/** Workflow A, steps 1–3 and 6: type, placement, bilingual names and the templated attributes. */
export async function createProduct(ctx: Ctx, input: ProductFields & { productTypeId: string }): Promise<ProductDetail> {
  authorize(ctx, 'catalogue.manage_products');
  const name = bilingualName(input);
  return inTx(ctx, async (tx) => {
    const type = await loadProductType(tx, input.productTypeId);
    if (!type.isActive) throw new DomainError('REFERENCE_INACTIVE', { entity: 'product_type', id: type.id });
    await assertPlacement(tx, input.categoryId, input.subCategoryId);
    const attributes = attributesFor(type.template, input);
    await assertVendor(tx, attributes.vendorId);
    const [row] = await mapUniqueViolations(tx.insert(products).values({
      productTypeId: type.id, categoryId: input.categoryId, subCategoryId: input.subCategoryId, ...name, ...attributes,
      createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: products.id }), { products_name_en_unique: duplicateProduct });
    if (!row) throw new Error('product insert returned nothing');
    await audit(tx, ctx, {
      action: 'catalogue.product_created', entityType: 'product', entityId: row.id,
      after: { productTypeId: type.id, categoryId: input.categoryId, subCategoryId: input.subCategoryId, ...name, ...attributes },
    });
    return loadProduct(tx, row.id);
  });
}

/** The product type is fixed: its template shaped the varieties and SKUs beneath. */
export async function updateProduct(
  ctx: Ctx, id: string, input: Partial<ProductFields> & { version: number; isActive?: boolean | undefined },
): Promise<ProductDetail> {
  authorize(ctx, 'catalogue.manage_products');
  return inTx(ctx, async (tx) => {
    const current = await loadProduct(tx, id);
    const categoryId = input.categoryId ?? current.category.id;
    const subCategoryId = input.subCategoryId ?? current.subCategory.id;
    if (categoryId !== current.category.id || subCategoryId !== current.subCategory.id) await assertPlacement(tx, categoryId, subCategoryId);
    const merged = {
      hybrid: input.hybrid === undefined ? current.hybrid : input.hybrid,
      countryOfOrigin: input.countryOfOrigin === undefined ? current.countryOfOrigin : input.countryOfOrigin,
      vendorId: input.vendorId === undefined ? (current.vendor?.id ?? null) : input.vendorId,
      shelfLifeMonths: input.shelfLifeMonths === undefined ? current.shelfLifeMonths : input.shelfLifeMonths,
    };
    const attributes = attributesFor(current.productType.template, merged);
    if (attributes.vendorId !== (current.vendor?.id ?? null)) await assertVendor(tx, attributes.vendorId);
    const next = {
      categoryId, subCategoryId,
      ...bilingualName({ nameEn: input.nameEn ?? current.nameEn, nameAr: input.nameAr ?? current.nameAr }),
      ...attributes,
      isActive: input.isActive ?? current.isActive,
    };
    const [row] = await mapUniqueViolations(tx.update(products)
      .set({ ...next, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 })
      .where(and(eq(products.id, id), eq(products.version, input.version)))
      .returning({ id: products.id }), { products_name_en_unique: duplicateProduct });
    if (!row) throw new DomainError('VERSION_CONFLICT', { entity: 'product', id });
    const before = { ...snapshot(current, next), categoryId: current.category.id, subCategoryId: current.subCategory.id, vendorId: current.vendor?.id ?? null };
    await audit(tx, ctx, { action: 'catalogue.product_updated', entityType: 'product', entityId: id, before, after: next });
    return loadProduct(tx, id);
  });
}

// ---------------------------------------------------------------- varieties

export async function createVariety(ctx: Ctx, productId: string, input: { nameEn: string; nameAr: string }): Promise<ProductDetail> {
  authorize(ctx, 'catalogue.manage_products');
  const name = bilingualName(input);
  return inTx(ctx, async (tx) => {
    const product = await loadProduct(tx, productId);
    if (product.productType.template.VARIETY === 'HIDDEN') throw new DomainError('ATTRIBUTE_NOT_ALLOWED', { attribute: 'VARIETY' });
    const [row] = await mapUniqueViolations(tx.insert(varieties).values({
      productId, ...name, createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: varieties.id }), { varieties_name_en_unique: duplicateProduct });
    if (!row) throw new Error('variety insert returned nothing');
    await audit(tx, ctx, { action: 'catalogue.variety_created', entityType: 'variety', entityId: row.id, after: { productId, ...name } });
    return loadProduct(tx, productId);
  });
}

export async function updateVariety(
  ctx: Ctx, id: string, input: { version: number; nameEn?: string | undefined; nameAr?: string | undefined; isActive?: boolean | undefined },
): Promise<ProductDetail> {
  authorize(ctx, 'catalogue.manage_products');
  return inTx(ctx, async (tx) => {
    const [current] = await tx.select().from(varieties).where(eq(varieties.id, id));
    if (!current) throw new DomainError('NOT_FOUND', { entity: 'variety', id });
    const next = {
      ...bilingualName({ nameEn: input.nameEn ?? current.nameEn, nameAr: input.nameAr ?? current.nameAr }),
      isActive: input.isActive ?? current.isActive,
    };
    const [row] = await mapUniqueViolations(tx.update(varieties)
      .set({ ...next, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 })
      .where(and(eq(varieties.id, id), eq(varieties.version, input.version)))
      .returning({ id: varieties.id }), { varieties_name_en_unique: duplicateProduct });
    if (!row) throw new DomainError('VERSION_CONFLICT', { entity: 'variety', id });
    await audit(tx, ctx, { action: 'catalogue.variety_updated', entityType: 'variety', entityId: id, before: snapshot(current, next), after: next });
    return loadProduct(tx, current.productId);
  });
}

// ---------------------------------------------------------------- SKUs

export type SizeInput =
  | { readonly measure: 'WEIGHT'; readonly value: string; readonly unit: 'G' | 'KG' }
  | { readonly measure: 'COUNT'; readonly count: number };

export function packSizeFrom(size: SizeInput): PackSize {
  return size.measure === 'WEIGHT'
    ? { measure: 'WEIGHT', packWeightG: packWeightGrams(size.value, size.unit) }
    : { measure: 'COUNT', packCount: packCountOf(size.count) };
}

async function skuContext(db: Executor, productId: string, varietyId: string | null) {
  const product = await loadProduct(db, productId);
  assertSkuVariety(product.productType.template, varietyId);
  const variety = varietyId ? product.varieties.find((v) => v.id === varietyId) : null;
  if (varietyId && !variety) throw new DomainError('NOT_FOUND', { entity: 'variety', id: varietyId });
  return { product, variety: variety ?? null };
}

async function generatedCode(db: Executor, base: string, packaging: Packaging): Promise<string> {
  const taken = new Set((await db.select({ code: skus.code }).from(skus).where(ilike(skus.code, `${base}%`))).map((r) => r.code));
  return resolveSkuCode(base, packaging, (c) => taken.has(c));
}

/** CAT-008: the code the system would give this SKU, shown before it is saved. */
export async function previewSkuCode(
  ctx: Ctx, productId: string, input: { varietyId?: string | null | undefined; size: SizeInput; packaging: Packaging },
): Promise<{ code: string }> {
  authorize(ctx, 'catalogue.manage_products');
  const db = getDb();
  const { product, variety } = await skuContext(db, productId, input.varietyId ?? null);
  const base = generateSkuCode({
    productNameEn: product.nameEn, varietyNameEn: variety?.nameEn ?? null, size: packSizeFrom(input.size), countUnit: product.productType.countUnit,
  });
  return { code: await generatedCode(db, base, input.packaging) };
}

async function writePrices(tx: Executor, ctx: Ctx, skuId: string, prices: readonly { priceListId: string; price: string }[]) {
  if (prices.length === 0) return;
  authorize(ctx, 'pricing.manage_price_lists');
  const ids = [...new Set(prices.map((p) => p.priceListId))];
  const lists = await tx.select({ id: priceLists.id, isActive: priceLists.isActive }).from(priceLists).where(inArray(priceLists.id, ids));
  for (const id of ids) {
    const list = lists.find((l) => l.id === id);
    if (!list) throw new DomainError('NOT_FOUND', { entity: 'price_list', id });
    if (!list.isActive) throw new DomainError('REFERENCE_INACTIVE', { entity: 'price_list', id });
  }
  for (const p of prices) {
    const amount = price(p.price);
    await tx.insert(priceListItems).values({ priceListId: p.priceListId, skuId, price: amount, updatedAt: ctx.now, updatedBy: ctx.user.id })
      .onConflictDoUpdate({ target: [priceListItems.priceListId, priceListItems.skuId], set: { price: amount, updatedAt: ctx.now, updatedBy: ctx.user.id } });
  }
}

/**
 * Workflow A, steps 4–5 (CAT-006..010, PRC-001): one SKU per pack size and
 * packaging, with its code generated unless one is given, and its prices.
 */
export async function createSku(
  ctx: Ctx, productId: string,
  input: {
    varietyId?: string | null | undefined; size: SizeInput; packaging: Packaging; code?: string | undefined;
    prices?: readonly { priceListId: string; price: string }[] | undefined;
  },
): Promise<ProductDetail> {
  authorize(ctx, 'catalogue.manage_products');
  const size = packSizeFrom(input.size);
  const override = input.code ? normaliseSkuCode(input.code) : null;
  return inTx(ctx, async (tx) => {
    const { product, variety } = await skuContext(tx, productId, input.varietyId ?? null);
    if (variety && !variety.isActive) throw new DomainError('REFERENCE_INACTIVE', { entity: 'variety', id: variety.id });
    const code = override ?? await generatedCode(tx, generateSkuCode({
      productNameEn: product.nameEn, varietyNameEn: variety?.nameEn ?? null, size, countUnit: product.productType.countUnit,
    }), input.packaging);
    const [row] = await mapUniqueViolations(tx.insert(skus).values({
      productId, varietyId: variety?.id ?? null, code, codeOverridden: override !== null, packaging: input.packaging,
      measure: size.measure,
      packWeightG: size.measure === 'WEIGHT' ? size.packWeightG : null,
      packCount: size.measure === 'COUNT' ? size.packCount : null,
      createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: skus.id }), { skus_code_unique: duplicateCode, skus_physical_identity: duplicateSku });
    if (!row) throw new Error('sku insert returned nothing');
    await writePrices(tx, ctx, row.id, input.prices ?? []);
    await audit(tx, ctx, {
      action: 'catalogue.sku_created', entityType: 'sku', entityId: row.id,
      after: { productId, varietyId: variety?.id ?? null, code, codeOverridden: override !== null, size, packaging: input.packaging, prices: input.prices ?? [] },
    });
    return loadProduct(tx, productId);
  });
}

/**
 * A SKU's code can be overridden and it can be retired; its size, packaging
 * and variety cannot change (DATA-MODEL §5.1) — that is a new SKU.
 */
export async function updateSku(
  ctx: Ctx, id: string, input: { version: number; code?: string | undefined; isActive?: boolean | undefined },
): Promise<ProductDetail> {
  authorize(ctx, 'catalogue.manage_products');
  return inTx(ctx, async (tx) => {
    const [current] = await tx.select().from(skus).where(eq(skus.id, id));
    if (!current) throw new DomainError('NOT_FOUND', { entity: 'sku', id });
    const code = input.code === undefined ? current.code : normaliseSkuCode(input.code);
    const next = { code, codeOverridden: current.codeOverridden || code !== current.code, isActive: input.isActive ?? current.isActive };
    const [row] = await mapUniqueViolations(tx.update(skus)
      .set({ ...next, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 })
      .where(and(eq(skus.id, id), eq(skus.version, input.version)))
      .returning({ id: skus.id }), { skus_code_unique: duplicateCode });
    if (!row) throw new DomainError('VERSION_CONFLICT', { entity: 'sku', id });
    await audit(tx, ctx, { action: 'catalogue.sku_updated', entityType: 'sku', entityId: id, before: snapshot(current, next), after: next });
    return loadProduct(tx, current.productId);
  });
}

// ---------------------------------------------------------------- SKU list

export type SkuSummary = Sku & {
  readonly product: { readonly id: ProductId; readonly nameEn: string; readonly nameAr: string };
  readonly variety: { readonly id: VarietyId; readonly nameEn: string; readonly nameAr: string } | null;
  readonly countUnit: CountUnit;
};

/** Every SKU, by code — what price lists and ceilings are set against. */
export async function listSkus(
  ctx: Ctx,
  filter: { search?: string | undefined; productId?: string | undefined; isActive?: boolean | undefined; cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: SkuSummary[]; nextCursor: string | null }> {
  authorizeAny(ctx, CATALOGUE_READERS);
  const limit = pageLimit(filter.limit, 100);
  const where: SQL[] = [];
  if (filter.productId) where.push(eq(skus.productId, filter.productId));
  if (filter.isActive !== undefined) where.push(eq(skus.isActive, filter.isActive));
  if (filter.search) {
    const q = likePattern(filter.search);
    where.push(or(ilike(skus.code, q), ilike(products.nameEn, q), ilike(products.nameAr, q), ilike(varieties.nameEn, q), ilike(varieties.nameAr, q)) as SQL);
  }
  if (filter.cursor) where.push(gt(skus.code, decodeCursor(filter.cursor, 1)[0] ?? ''));
  const rows = await getDb()
    .select({ sku: skus, product: { id: products.id, nameEn: products.nameEn, nameAr: products.nameAr }, varietyEn: varieties.nameEn, varietyAr: varieties.nameAr, countUnit: productTypes.countUnit, basePrice: priceListItems.price })
    .from(skus)
    .innerJoin(products, eq(products.id, skus.productId))
    .innerJoin(productTypes, eq(productTypes.id, products.productTypeId))
    .leftJoin(varieties, eq(varieties.id, skus.varietyId))
    .leftJoin(priceLists, eq(priceLists.isBase, true))
    .leftJoin(priceListItems, and(eq(priceListItems.priceListId, priceLists.id), eq(priceListItems.skuId, skus.id)))
    .where(and(...where))
    .orderBy(asc(skus.code))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.sku.id as SkuId, varietyId: r.sku.varietyId as VarietyId | null, code: r.sku.code, codeOverridden: r.sku.codeOverridden,
      size: sizeOf(r.sku), packaging: r.sku.packaging, isActive: r.sku.isActive, version: r.sku.version,
      basePrice: (r.basePrice ?? null) as Money | null,
      product: { ...r.product, id: r.product.id as ProductId },
      variety: r.sku.varietyId && r.varietyEn !== null && r.varietyAr !== null ? { id: r.sku.varietyId as VarietyId, nameEn: r.varietyEn, nameAr: r.varietyAr } : null,
      countUnit: r.countUnit,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.sku.code]) : null,
  };
}
