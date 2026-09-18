import type { Ctx } from '../src/context';
import { createCategory, createProduct, createSubCategory, createVariety, listProductTypes } from '../src/catalogue';
import { createVendor } from '../src/vendors';

let n = 0;

/** A category with one sub-category, a vendor, and the two synced product types. */
export async function aCatalogueBase(ctx: Ctx) {
  n += 1;
  const category = await createCategory(ctx, { nameEn: `Vegetable Seeds ${n}`, nameAr: `بذور خضروات ${n}` });
  const withSub = await createSubCategory(ctx, category.id, { nameEn: 'Open Pollinated', nameAr: 'غير هجين' });
  const sub = withSub.subCategories[0];
  if (!sub) throw new Error('sub-category missing');
  const vendor = await createVendor(ctx, { code: `VEN-T${n}`, name: `Seed House ${n}`, country: 'IN' });
  const types = await listProductTypes(ctx);
  const seeds = types.find((t) => t.code === 'SEEDS');
  const essentials = types.find((t) => t.code === 'ESSENTIALS');
  if (!seeds || !essentials) throw new Error('product types not synced');
  return { category, sub, vendor, seeds, essentials };
}

/** Okra / Parbhani Kranti — the scope's own example. */
export async function anOkra(ctx: Ctx) {
  const base = await aCatalogueBase(ctx);
  const product = await createProduct(ctx, {
    productTypeId: base.seeds.id, categoryId: base.category.id, subCategoryId: base.sub.id,
    nameEn: 'Okra', nameAr: 'بامية', hybrid: 'NON_HYBRID', countryOfOrigin: 'IN', vendorId: base.vendor.id, shelfLifeMonths: 24,
  });
  const withVariety = await createVariety(ctx, product.id, { nameEn: 'Parbhani Kranti', nameAr: 'بارباني كرانتي' });
  const variety = withVariety.varieties[0];
  if (!variety) throw new Error('variety missing');
  return { ...base, product: withVariety, variety };
}
