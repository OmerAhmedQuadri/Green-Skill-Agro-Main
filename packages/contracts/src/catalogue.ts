import { z } from 'zod';
import { Limit, MoneyString, NameAr, NameEn, QueryBoolean, Version } from './shared';

/** Catalogue API contracts (API.md — Catalogue, pricing, vendors). */
export const ProductAttribute = z.enum([
  'VARIETY', 'HYBRID', 'COUNTRY_OF_ORIGIN', 'VENDOR', 'LOT_NUMBER', 'MANUFACTURING_DATE', 'EXPIRY', 'SHELF_LIFE',
]);
export const AttributeMode = z.enum(['HIDDEN', 'OPTIONAL', 'REQUIRED']);
export const CountUnit = z.enum(['SEED', 'PIECE']);
export const Packaging = z.enum(['CAN', 'POUCH', 'BAG']);
export const Hybrid = z.enum(['HYBRID', 'NON_HYBRID']);
export const Template = z.object(Object.fromEntries(ProductAttribute.options.map((a) => [a, AttributeMode])) as Record<z.infer<typeof ProductAttribute>, typeof AttributeMode>);

const ExpiryWarningDays = z.number().int().min(1).max(730);
const SortOrder = z.number().int().min(0).max(9999);

export const CreateCategoryRequest = z.object({
  nameEn: NameEn, nameAr: NameAr, expiryWarningDays: ExpiryWarningDays.nullable().optional(), sortOrder: SortOrder.optional(),
});
export const UpdateCategoryRequest = z.object({
  version: Version, nameEn: NameEn.optional(), nameAr: NameAr.optional(), expiryWarningDays: ExpiryWarningDays.nullable().optional(),
  sortOrder: SortOrder.optional(), isActive: z.boolean().optional(),
});
export const CreateSubCategoryRequest = z.object({ nameEn: NameEn, nameAr: NameAr, sortOrder: SortOrder.optional() });
export const UpdateSubCategoryRequest = z.object({
  version: Version, nameEn: NameEn.optional(), nameAr: NameAr.optional(), sortOrder: SortOrder.optional(), isActive: z.boolean().optional(),
});

export const CreateProductTypeRequest = z.object({ nameEn: NameEn, nameAr: NameAr, countUnit: CountUnit, template: Template });
export const UpdateProductTypeRequest = z.object({
  version: Version, nameEn: NameEn.optional(), nameAr: NameAr.optional(), countUnit: CountUnit.optional(),
  isActive: z.boolean().optional(), template: Template.optional(),
});

export const ListProductsQuery = z.object({
  search: z.string().trim().max(100).optional(),
  productTypeId: z.uuid().optional(), categoryId: z.uuid().optional(), subCategoryId: z.uuid().optional(), vendorId: z.uuid().optional(),
  isActive: QueryBoolean.optional(), cursor: z.string().max(500).optional(), limit: Limit.optional(),
});

const ProductFields = {
  categoryId: z.uuid(), subCategoryId: z.uuid(), nameEn: NameEn, nameAr: NameAr,
  hybrid: Hybrid.nullable().optional(),
  countryOfOrigin: z.string().trim().length(2).nullable().optional(),
  vendorId: z.uuid().nullable().optional(),
  shelfLifeMonths: z.number().int().min(1).max(240).nullable().optional(),
};
export const CreateProductRequest = z.object({ productTypeId: z.uuid(), ...ProductFields });
export const UpdateProductRequest = z.object({
  version: Version, ...z.object(ProductFields).partial().shape, isActive: z.boolean().optional(),
});

export const CreateVarietyRequest = z.object({ nameEn: NameEn, nameAr: NameAr });
export const UpdateVarietyRequest = z.object({ version: Version, nameEn: NameEn.optional(), nameAr: NameAr.optional(), isActive: z.boolean().optional() });

/** CAT-010: by weight (entered in g or kg) or by count — never both. */
export const SizeInput = z.discriminatedUnion('measure', [
  z.object({ measure: z.literal('WEIGHT'), value: z.string().trim().regex(/^\d{1,9}(\.\d{1,6})?$/), unit: z.enum(['G', 'KG']) }),
  z.object({ measure: z.literal('COUNT'), count: z.number().int().min(1).max(10_000_000) }),
]);

export const CreateSkuRequest = z.object({
  varietyId: z.uuid().nullable().optional(),
  size: SizeInput,
  packaging: Packaging,
  code: z.string().trim().max(40).optional().transform((v) => v || undefined), // CAT-008 override
  prices: z.array(z.object({ priceListId: z.uuid(), price: MoneyString })).max(20).optional(),
});
export const UpdateSkuRequest = z.object({ version: Version, code: z.string().trim().min(1).max(40).optional(), isActive: z.boolean().optional() });

/** GET /products/:id/sku-code — the size arrives as query parameters. */
export const SkuCodePreviewQuery = z.object({
  varietyId: z.uuid().optional(), packaging: Packaging, measure: z.enum(['WEIGHT', 'COUNT']),
  value: z.string().optional(), unit: z.enum(['G', 'KG']).optional(), count: z.coerce.number().int().optional(),
}).transform((q, ctx) => {
  const size = SizeInput.safeParse(q.measure === 'WEIGHT' ? { measure: 'WEIGHT', value: q.value, unit: q.unit } : { measure: 'COUNT', count: q.count });
  if (!size.success) {
    ctx.addIssue({ code: 'custom', message: 'INVALID_PACK_SIZE', path: ['measure'] });
    return z.NEVER;
  }
  return { varietyId: q.varietyId ?? null, packaging: q.packaging, size: size.data };
});

export const ListSkusQuery = z.object({
  search: z.string().trim().max(100).optional(), productId: z.uuid().optional(), isActive: QueryBoolean.optional(),
  cursor: z.string().max(500).optional(), limit: Limit.optional(),
});

