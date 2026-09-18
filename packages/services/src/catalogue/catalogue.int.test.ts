import type { DomainError, PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { aCatalogueBase, anOkra } from '../../test/catalogue';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { listPriceLists } from '../pricing';
import {
  createCategory, createProduct, createProductType, createSku, createSubCategory, createVariety, getProduct, listCategories,
  listProducts, listProductTypes, listSkus, previewSkuCode, updateCategory, updateProduct, updateProductType, updateSku,
} from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async () => ctxFor(await anAccount('ADMIN'));
const manager = async (grants: PermissionCode[] = []) =>
  ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });
const bag5kg = { measure: 'WEIGHT', value: '5', unit: 'KG' } as const;

describe('catalogue structure (CAT-001..003)', () => {
  it('CAT-002: the Admin maintains categories and sub-categories in the application', async () => {
    const ctx = await admin();
    const category = await createCategory(ctx, { nameEn: 'Vegetable Seeds', nameAr: 'بذور خضروات', expiryWarningDays: 90 });
    const withSubs = await createSubCategory(ctx, category.id, { nameEn: 'Hybrid F1', nameAr: 'هجين إف1' });
    expect(withSubs.subCategories.map((s) => s.nameEn)).toEqual(['Hybrid F1']);
    const renamed = await updateCategory(ctx, category.id, { version: category.version, nameEn: 'Vegetable seeds' });
    expect(renamed.nameEn).toBe('Vegetable seeds');
    expect((await listCategories(ctx)).map((c) => c.id)).toEqual([category.id]);
  });

  it('CAT-002: names are unique regardless of case; a stale version is refused', async () => {
    const ctx = await admin();
    const category = await createCategory(ctx, { nameEn: 'Vegetable Seeds', nameAr: 'بذور خضروات' });
    expect(await code(createCategory(ctx, { nameEn: 'vegetable seeds', nameAr: 'أخرى' }))).toBe('DUPLICATE_NAME');
    await createSubCategory(ctx, category.id, { nameEn: 'Open Pollinated', nameAr: 'غير هجين' });
    expect(await code(createSubCategory(ctx, category.id, { nameEn: 'OPEN POLLINATED', nameAr: 'غير هجين' }))).toBe('DUPLICATE_NAME');
    await updateCategory(ctx, category.id, { version: category.version, sortOrder: 2 });
    expect(await code(updateCategory(ctx, category.id, { version: category.version, sortOrder: 3 }))).toBe('VERSION_CONFLICT');
  });

  it('CAT-002: maintaining the structure needs catalogue.manage_structure', async () => {
    expect(await code(createCategory(await manager(['catalogue.view']), { nameEn: 'X', nameAr: 'س' }))).toBe('FORBIDDEN');
    expect(await code(createCategory(await manager(['catalogue.manage_structure']), { nameEn: 'X', nameAr: 'س' }))).toBe('NO_ERROR');
  });

  it('SYS-009: structure changes are audited with before and after', async () => {
    const ctx = await admin();
    const category = await createCategory(ctx, { nameEn: 'Seeds', nameAr: 'بذور' });
    await updateCategory(ctx, category.id, { version: category.version, expiryWarningDays: 60 });
    const rows = await ownerQuery<{ action: string; before: unknown; after: unknown }>(
      `select action, before, after from audit_log where entity_id = $1 order by occurred_at`, [category.id]);
    expect(rows.map((r) => r.action)).toEqual(['catalogue.category_created', 'catalogue.category_updated']);
    expect(rows[1]?.before).toMatchObject({ expiryWarningDays: null });
    expect(rows[1]?.after).toMatchObject({ expiryWarningDays: 60 });
  });
});

describe('product types and templates (CAT-013..016, SYS-004)', () => {
  it('CAT-014: Seeds and Agriculture essentials exist from setup, with their templates', async () => {
    const types = await listProductTypes(await admin());
    expect(types.map((t) => t.code)).toEqual(['SEEDS', 'ESSENTIALS']);
    expect(types[0]?.template.VARIETY).toBe('REQUIRED');
    expect(types[1]?.template.EXPIRY).toBe('HIDDEN');
    expect(types[1]?.countUnit).toBe('PIECE');
  });

  it('CAT-013: the type decides which attributes a product must carry', async () => {
    const ctx = await admin();
    const base = await aCatalogueBase(ctx);
    const placement = { categoryId: base.category.id, subCategoryId: base.sub.id };
    expect(await code(createProduct(ctx, { productTypeId: base.seeds.id, ...placement, nameEn: 'Okra', nameAr: 'بامية', vendorId: base.vendor.id })))
      .toBe('ATTRIBUTE_REQUIRED');
    const net = await createProduct(ctx, {
      productTypeId: base.essentials.id, ...placement, nameEn: 'Shade Net 50% 3m x 50m', nameAr: 'شبك تظليل', vendorId: base.vendor.id,
      countryOfOrigin: 'IN', hybrid: 'HYBRID', // hidden on essentials: dropped, not stored
    });
    expect(net).toMatchObject({ countryOfOrigin: null, hybrid: null, vendor: { id: base.vendor.id } });
  });

  it('CAT-015: the Admin can enable an attribute on any type', async () => {
    const ctx = await admin();
    const base = await aCatalogueBase(ctx);
    await updateProductType(ctx, base.essentials.id, { version: base.essentials.version, template: { ...base.essentials.template, COUNTRY_OF_ORIGIN: 'REQUIRED' } });
    const input = { productTypeId: base.essentials.id, categoryId: base.category.id, subCategoryId: base.sub.id, nameEn: 'Mesh', nameAr: 'شبك', vendorId: base.vendor.id };
    expect(await code(createProduct(ctx, input))).toBe('ATTRIBUTE_REQUIRED');
    expect((await createProduct(ctx, { ...input, countryOfOrigin: 'cn' })).countryOfOrigin).toBe('CN');
  });

  it('CAT-016: a type with expiry disabled cannot carry a shelf life', async () => {
    const ctx = await admin();
    const base = await aCatalogueBase(ctx);
    expect(await code(updateProductType(ctx, base.essentials.id, {
      version: base.essentials.version, template: { ...base.essentials.template, SHELF_LIFE: 'OPTIONAL' },
    }))).toBe('INVALID_TEMPLATE');
  });

  it('SYS-004: templates are managed only with system.manage_templates, and audited', async () => {
    const ctx = await admin();
    const types = await listProductTypes(ctx);
    const seeds = types[0];
    if (!seeds) throw new Error('no types');
    expect(await code(updateProductType(await manager(['catalogue.manage_products']), seeds.id, { version: seeds.version, nameEn: 'X' }))).toBe('FORBIDDEN');
    const tools = await createProductType(ctx, { nameEn: 'Tools', nameAr: 'أدوات', countUnit: 'PIECE', template: { ...seeds.template, VARIETY: 'HIDDEN', EXPIRY: 'HIDDEN', SHELF_LIFE: 'HIDDEN' } });
    expect(tools.code).toBe('TOOLS');
    const [row] = await ownerQuery<{ action: string }>(`select action from audit_log where entity_id = $1`, [tools.id]);
    expect(row?.action).toBe('system.product_type_created');
  });
});

describe('products, varieties and SKUs (CAT-001, CAT-004..012, CAT-017, I18N-003)', () => {
  it('CAT-004, I18N-003: product and variety names are stored in English and Arabic', async () => {
    const ctx = await admin();
    const { product } = await anOkra(ctx);
    const rows = await ownerQuery<{ name_en: string; name_ar: string }>(`select name_en, name_ar from varieties where product_id = $1`, [product.id]);
    expect(rows).toEqual([{ name_en: 'Parbhani Kranti', name_ar: 'بارباني كرانتي' }]);
    expect(product).toMatchObject({ nameEn: 'Okra', nameAr: 'بامية' });
  });

  it('CAT-005, CAT-017: a product carries type, placement, hybrid flag, origin, vendor and shelf life', async () => {
    const ctx = await admin();
    const { product, category, sub, vendor } = await anOkra(ctx);
    expect(product).toMatchObject({
      category: { id: category.id }, subCategory: { id: sub.id }, hybrid: 'NON_HYBRID', countryOfOrigin: 'IN',
      vendor: { id: vendor.id, code: vendor.code }, shelfLifeMonths: 24,
    });
  });

  it('CAT-002: a sub-category must belong to the chosen category', async () => {
    const ctx = await admin();
    const a = await aCatalogueBase(ctx);
    const b = await aCatalogueBase(ctx);
    expect(await code(createProduct(ctx, {
      productTypeId: a.seeds.id, categoryId: a.category.id, subCategoryId: b.sub.id, nameEn: 'Okra', nameAr: 'بامية',
      hybrid: 'HYBRID', countryOfOrigin: 'IN', vendorId: a.vendor.id,
    }))).toBe('NOT_FOUND');
  });

  it('CAT-006, CAT-007: one product in several SKUs, each its own pack size and packaging', async () => {
    const ctx = await admin();
    const { product, variety } = await anOkra(ctx);
    await createSku(ctx, product.id, { varietyId: variety.id, size: bag5kg, packaging: 'BAG' });
    await createSku(ctx, product.id, { varietyId: variety.id, size: { measure: 'WEIGHT', value: '1', unit: 'KG' }, packaging: 'POUCH' });
    const after = await createSku(ctx, product.id, { varietyId: variety.id, size: { measure: 'WEIGHT', value: '50', unit: 'G' }, packaging: 'CAN' });
    expect(after.skus.map((s) => s.code).sort()).toEqual(['OKRA-PK-1KG', 'OKRA-PK-50G', 'OKRA-PK-5KG']);
    expect(await code(createSku(ctx, product.id, { varietyId: variety.id, size: { measure: 'WEIGHT', value: '5000', unit: 'G' }, packaging: 'BAG' })))
      .toBe('DUPLICATE_SKU'); // 5000 g is the same pack as 5 kg
  });

  it('CAT-008: the code is generated, previewed first, and a clash takes the packaging letter', async () => {
    const ctx = await admin();
    const { product, variety } = await anOkra(ctx);
    const preview = await previewSkuCode(ctx, product.id, { varietyId: variety.id, size: bag5kg, packaging: 'BAG' });
    expect(preview.code).toBe('OKRA-PK-5KG');
    await createSku(ctx, product.id, { varietyId: variety.id, size: bag5kg, packaging: 'BAG' });
    const pouch = await createSku(ctx, product.id, { varietyId: variety.id, size: bag5kg, packaging: 'POUCH' });
    expect(pouch.skus.map((s) => s.code)).toContain('OKRA-PK-5KG-P');
  });

  it('CAT-008: an overridden code is kept and remembered as overridden', async () => {
    const ctx = await admin();
    const { product, variety } = await anOkra(ctx);
    const created = await createSku(ctx, product.id, { varietyId: variety.id, size: bag5kg, packaging: 'BAG', code: 'okra-5kg' });
    const sku = created.skus[0];
    expect(sku).toMatchObject({ code: 'OKRA-5KG', codeOverridden: true });
    if (!sku) throw new Error('sku missing');
    const renamed = await updateProduct(ctx, product.id, { version: created.version, nameEn: 'Okra OP' });
    expect(renamed.skus[0]?.code).toBe('OKRA-5KG'); // codes never follow later renames
    expect(await code(updateSku(ctx, sku.id, { version: sku.version, code: 'OKRA 5KG' }))).toBe('INVALID_SKU_CODE');
    await createSku(ctx, product.id, { varietyId: variety.id, size: { measure: 'WEIGHT', value: '1', unit: 'KG' }, packaging: 'POUCH', code: 'X-1' });
    expect(await code(updateSku(ctx, sku.id, { version: sku.version, code: 'x-1' }))).toBe('DUPLICATE_CODE');
  });

  it('CAT-009: packaging is a can, a pouch or a bag', async () => {
    const [row] = await ownerQuery<{ values: string }>(`select string_agg(e::text, ',' order by e::text) as values from unnest(enum_range(null::packaging_type)) e`);
    expect(row?.values).toBe('BAG,CAN,POUCH');
  });

  it('CAT-010: a SKU is sized by weight or by count — never both; weight at least 0.1 g', async () => {
    const ctx = await admin();
    const { product, variety } = await anOkra(ctx);
    expect(await code(createSku(ctx, product.id, { varietyId: variety.id, size: { measure: 'WEIGHT', value: '0.05', unit: 'G' }, packaging: 'CAN' }))).toBe('INVALID_PACK_SIZE');
    const seeds500 = await createSku(ctx, product.id, { varietyId: variety.id, size: { measure: 'COUNT', count: 500 }, packaging: 'CAN' });
    expect(seeds500.skus[0]).toMatchObject({ code: 'OKRA-PK-500S', size: { measure: 'COUNT', packCount: 500 } });
    const both = ownerQuery(`update skus set pack_weight_g = 1 where product_id = $1`, [product.id]);
    await expect(both).rejects.toThrow(/skus_pack_size_union/);
  });

  it('CAT-011: pack weight holds three decimals of a gram; a count is a whole number', async () => {
    const ctx = await admin();
    const { product, variety } = await anOkra(ctx);
    const fine = await createSku(ctx, product.id, { varietyId: variety.id, size: { measure: 'WEIGHT', value: '0.125', unit: 'G' }, packaging: 'CAN' });
    expect(fine.skus[0]?.size).toEqual({ measure: 'WEIGHT', packWeightG: '0.125' });
    expect(await code(createSku(ctx, product.id, { varietyId: variety.id, size: { measure: 'COUNT', count: 2.5 }, packaging: 'CAN' }))).toBe('INVALID_PACK_SIZE');
  });

  it('CAT-012: there is no outer-carton unit', async () => {
    const columns = await ownerQuery<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'skus'`);
    expect(columns.map((c) => c.column_name).filter((c) => /carton|outer|case/.test(c))).toEqual([]);
  });

  it('CAT-001: a SKU sits under a variety for seeds, and directly under the product for essentials', async () => {
    const ctx = await admin();
    const { product, essentials, category, sub, vendor } = await anOkra(ctx);
    expect(await code(createSku(ctx, product.id, { size: bag5kg, packaging: 'BAG' }))).toBe('ATTRIBUTE_REQUIRED');
    const net = await createProduct(ctx, {
      productTypeId: essentials.id, categoryId: category.id, subCategoryId: sub.id, nameEn: 'Shade Net 50% 3m x 50m', nameAr: 'شبك تظليل', vendorId: vendor.id,
    });
    expect(await code(createVariety(ctx, net.id, { nameEn: 'X', nameAr: 'س' }))).toBe('ATTRIBUTE_NOT_ALLOWED');
    const roll = await createSku(ctx, net.id, { size: { measure: 'COUNT', count: 1 }, packaging: 'BAG' });
    expect(roll.skus[0]?.code).toBe('SHAD-1PC');
  });

  it('PRC-001: prices can be entered with the SKU, on the base and additional lists', async () => {
    const ctx = await admin();
    const { product, variety } = await anOkra(ctx);
    const [base] = await listPriceLists(ctx);
    if (!base) throw new Error('no base list');
    const created = await createSku(ctx, product.id, { varietyId: variety.id, size: bag5kg, packaging: 'BAG', prices: [{ priceListId: base.id, price: '86.10' }] });
    expect(created.skus[0]?.basePrice).toBe('86.10');
    const noPricing = await manager(['catalogue.manage_products']);
    expect(await code(createSku(noPricing, product.id, { varietyId: variety.id, size: { measure: 'WEIGHT', value: '1', unit: 'KG' }, packaging: 'POUCH', prices: [{ priceListId: base.id, price: '20' }] })))
      .toBe('FORBIDDEN');
  });

  it('CAT-004: products list in the reader\'s language and search across names, varieties and codes', async () => {
    const ctx = await admin();
    const { product, variety, seeds, category, sub, vendor } = await anOkra(ctx);
    await createSku(ctx, product.id, { varietyId: variety.id, size: bag5kg, packaging: 'BAG' });
    await createProduct(ctx, {
      productTypeId: seeds.id, categoryId: category.id, subCategoryId: sub.id, nameEn: 'Carrot', nameAr: 'جزر',
      hybrid: 'NON_HYBRID', countryOfOrigin: 'IN', vendorId: vendor.id,
    });
    expect((await listProducts(ctx)).items.map((p) => p.nameEn)).toEqual(['Carrot', 'Okra']);
    expect((await listProducts({ ...ctx, locale: 'ar' })).items.map((p) => p.nameAr)).toEqual(['بامية', 'جزر']);
    expect((await listProducts(ctx, { search: 'pk-5' })).items.map((p) => p.nameEn)).toEqual(['Okra']);
    expect((await listProducts(ctx, { search: 'Kranti' })).items.map((p) => p.nameEn)).toEqual(['Okra']);
    const first = await listProducts(ctx, { limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    expect((await listProducts(ctx, { limit: 1, cursor: first.nextCursor ?? '' })).items.map((p) => p.nameEn)).toEqual(['Okra']);
    expect((await listSkus(ctx, { search: 'okra' })).items.map((s) => s.code)).toEqual(['OKRA-PK-5KG']);
  });

  it('USR-008: reading the catalogue needs a catalogue or pricing permission; sellers have none', async () => {
    const ctx = await admin();
    const { product } = await anOkra(ctx);
    expect(await code(getProduct(await ctxFor(await anAccount('SELLER')), product.id))).toBe('FORBIDDEN');
    expect(await code(getProduct(await manager(), product.id))).toBe('FORBIDDEN');
    expect(await code(getProduct(await manager(['catalogue.view']), product.id))).toBe('NO_ERROR');
    expect(await code(createProduct(await manager(['catalogue.view']), {
      productTypeId: product.productType.id, categoryId: product.category.id, subCategoryId: product.subCategory.id, nameEn: 'Y', nameAr: 'ي',
    }))).toBe('FORBIDDEN');
  });
});
