import {
  createCategory, createProduct, createSku, createSubCategory, createVariety, listCategories, listProductTypes,
  type Category, type SizeInput,
} from '../catalogue';
import type { Ctx } from '../context';
import { createPriceList, listPriceLists, setPriceListItems } from '../pricing';
import { createVendor } from '../vendors';

/**
 * MIG-006, CAT-003: a working sample so the system is usable from day one.
 * Synthetic by design (docs CLIENT-DATA): the same shape as Green Skill Agro's
 * catalogue — its category structure, the mix of cans, pouches and bags, grams,
 * kilograms and seed counts — but invented vendors, varieties and prices.
 * Real data arrives through the migration import (MIG-001..005).
 */
const STRUCTURE = [
  { nameEn: 'Vegetable Seeds', nameAr: 'بذور خضروات', expiryWarningDays: 90, subs: [
    { nameEn: 'Hybrid F1', nameAr: 'هجين إف1' }, { nameEn: 'Open Pollinated', nameAr: 'غير هجين' },
  ] },
  { nameEn: 'Agriculture Essentials', nameAr: 'مستلزمات زراعية', expiryWarningDays: null, subs: [
    { nameEn: 'Shade Nets & Mesh', nameAr: 'شبك تظليل' },
  ] },
] as const;

const g = (value: string): SizeInput => ({ measure: 'WEIGHT', value, unit: 'G' });
const kg = (value: string): SizeInput => ({ measure: 'WEIGHT', value, unit: 'KG' });
const count = (n: number): SizeInput => ({ measure: 'COUNT', count: n });

type SampleSku = { size: SizeInput; packaging: 'CAN' | 'POUCH' | 'BAG'; price: string; bulk?: string };
type SampleProduct = {
  sub: string; nameEn: string; nameAr: string; hybrid: 'HYBRID' | 'NON_HYBRID'; vendor: string;
  varieties: { nameEn: string; nameAr: string; skus: SampleSku[] }[];
};

// Okra / Parbhani Kranti / OKRA-PK-5KG is the scope's own worked example; the
// 5 kg bag and 1 kg pouch of one variety exercise conversion (workflow D).
const SEED_PRODUCTS: SampleProduct[] = [
  { sub: 'Open Pollinated', nameEn: 'Okra', nameAr: 'بامية', hybrid: 'NON_HYBRID', vendor: 'VEN-SAMPLE1', varieties: [
    { nameEn: 'Parbhani Kranti', nameAr: 'بارباني كرانتي', skus: [
      { size: kg('5'), packaging: 'BAG', price: '90.00', bulk: '85.00' },
      { size: kg('1'), packaging: 'POUCH', price: '25.00' },
      { size: g('50'), packaging: 'CAN', price: '12.00' },
    ] },
  ] },
  { sub: 'Open Pollinated', nameEn: 'Carrot', nameAr: 'جزر', hybrid: 'NON_HYBRID', vendor: 'VEN-SAMPLE1', varieties: [
    { nameEn: 'Sample Orange', nameAr: 'برتقالي تجريبي', skus: [{ size: g('50'), packaging: 'CAN', price: '14.00' }] },
  ] },
  { sub: 'Open Pollinated', nameEn: 'Spinach', nameAr: 'سبانخ', hybrid: 'NON_HYBRID', vendor: 'VEN-SAMPLE1', varieties: [
    { nameEn: 'Sample Leaf', nameAr: 'ورقي تجريبي', skus: [{ size: g('500'), packaging: 'CAN', price: '30.00' }] },
  ] },
  { sub: 'Hybrid F1', nameEn: 'Cucumber F1', nameAr: 'خيار', hybrid: 'HYBRID', vendor: 'VEN-SAMPLE1', varieties: [
    { nameEn: 'Sample Crisp F1', nameAr: 'مقرمش تجريبي F1', skus: [{ size: g('50'), packaging: 'CAN', price: '40.00', bulk: '37.50' }] },
  ] },
  { sub: 'Hybrid F1', nameEn: 'Papaya F1', nameAr: 'بابايا', hybrid: 'HYBRID', vendor: 'VEN-SAMPLE1', varieties: [
    { nameEn: 'Sample Sun F1', nameAr: 'شمس تجريبي F1', skus: [{ size: count(500), packaging: 'POUCH', price: '150.00' }] },
  ] },
];

/** Idempotent: does nothing once the catalogue has any category. */
export async function loadSampleCatalogue(ctx: Ctx, opts: { withProducts: boolean }): Promise<{ loaded: boolean }> {
  if ((await listCategories(ctx)).length > 0) return { loaded: false };

  const subIds = new Map<string, { categoryId: string; subCategoryId: string }>();
  for (const c of STRUCTURE) {
    let category: Category = await createCategory(ctx, { nameEn: c.nameEn, nameAr: c.nameAr, expiryWarningDays: c.expiryWarningDays });
    for (const s of c.subs) category = await createSubCategory(ctx, category.id, s);
    for (const s of category.subCategories) subIds.set(s.nameEn, { categoryId: category.id, subCategoryId: s.id });
  }
  if (!opts.withProducts) return { loaded: true };

  const vendors = new Map<string, string>();
  for (const v of [
    { code: 'VEN-SAMPLE1', name: 'Sample Seed House', country: 'IN', contactPerson: 'Sample Contact', email: 'seeds@example.com' },
    { code: 'VEN-SAMPLE2', name: 'Sample Net Trading', country: 'CN', contactPerson: 'Sample Contact', email: 'nets@example.com' },
  ]) vendors.set(v.code, (await createVendor(ctx, v)).id);

  const types = await listProductTypes(ctx);
  const seedType = types.find((t) => t.code === 'SEEDS');
  const essentialsType = types.find((t) => t.code === 'ESSENTIALS');
  const [base] = await listPriceLists(ctx);
  if (!seedType || !essentialsType || !base) throw new Error('reference data missing — run pnpm db:sync');
  const bulk = await createPriceList(ctx, { nameEn: 'Bulk buyers (sample)', nameAr: 'كبار المشترين (تجريبية)' });
  const bulkPrices: { skuId: string; price: string }[] = [];

  for (const p of SEED_PRODUCTS) {
    const place = subIds.get(p.sub);
    if (!place) throw new Error(`sample sub-category ${p.sub} missing`);
    let product = await createProduct(ctx, {
      productTypeId: seedType.id, ...place, nameEn: p.nameEn, nameAr: p.nameAr, hybrid: p.hybrid,
      countryOfOrigin: 'IN', vendorId: vendors.get(p.vendor) ?? null, shelfLifeMonths: 24,
    });
    for (const v of p.varieties) {
      product = await createVariety(ctx, product.id, { nameEn: v.nameEn, nameAr: v.nameAr });
      const varietyId = product.varieties.find((x) => x.nameEn === v.nameEn)?.id ?? null;
      for (const s of v.skus) {
        const before = new Set(product.skus.map((x) => x.id));
        product = await createSku(ctx, product.id, { varietyId, size: s.size, packaging: s.packaging, prices: [{ priceListId: base.id, price: s.price }] });
        const created = product.skus.find((x) => !before.has(x.id));
        if (created && s.bulk) bulkPrices.push({ skuId: created.id, price: s.bulk });
      }
    }
  }

  // Essentials: size lives in the name; sold by the piece (scope §04).
  const nets = subIds.get('Shade Nets & Mesh');
  if (!nets) throw new Error('sample sub-category Shade Nets & Mesh missing');
  const net = await createProduct(ctx, {
    productTypeId: essentialsType.id, ...nets, nameEn: 'Shade Net 50% 3m x 50m', nameAr: 'شبك تظليل 50% 3م × 50م',
    vendorId: vendors.get('VEN-SAMPLE2') ?? null,
  });
  await createSku(ctx, net.id, { size: count(1), packaging: 'BAG', prices: [{ priceListId: base.id, price: '320.00' }] });

  if (bulkPrices.length) await setPriceListItems(ctx, bulk.id, bulkPrices);
  return { loaded: true };
}

