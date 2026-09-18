import { DomainError } from '../errors';

/**
 * Attribute templates (CAT-013..016). Each product type decides, per optional
 * attribute, whether it is hidden, optional or required. Product name,
 * category, sub-category, SKU and price are not optional attributes: every
 * product has them.
 */
export const PRODUCT_ATTRIBUTES = [
  'VARIETY',
  'HYBRID',
  'COUNTRY_OF_ORIGIN',
  'VENDOR',
  'LOT_NUMBER',
  'MANUFACTURING_DATE',
  'EXPIRY',
  'SHELF_LIFE',
] as const;
export type ProductAttribute = (typeof PRODUCT_ATTRIBUTES)[number];

export const ATTRIBUTE_MODES = ['HIDDEN', 'OPTIONAL', 'REQUIRED'] as const;
export type AttributeMode = (typeof ATTRIBUTE_MODES)[number];

export type Template = Readonly<Record<ProductAttribute, AttributeMode>>;

/** What a seed pack counts when it is sized by count; essentials count pieces. */
export const COUNT_UNITS = ['SEED', 'PIECE'] as const;
export type CountUnit = (typeof COUNT_UNITS)[number];

/**
 * The two product types Phase 1 ships (CAT-014, scope §04). Seeds carry the
 * full set; agriculture essentials carry name, category, vendor, SKU and price,
 * with size expressed in the name. The Admin can change either afterwards (CAT-015).
 */
export const DEFAULT_PRODUCT_TYPES = {
  SEEDS: {
    nameEn: 'Seeds', nameAr: 'بذور', countUnit: 'SEED',
    template: {
      VARIETY: 'REQUIRED', HYBRID: 'REQUIRED', COUNTRY_OF_ORIGIN: 'REQUIRED', VENDOR: 'REQUIRED',
      LOT_NUMBER: 'REQUIRED', MANUFACTURING_DATE: 'REQUIRED', EXPIRY: 'REQUIRED', SHELF_LIFE: 'OPTIONAL',
    },
  },
  ESSENTIALS: {
    nameEn: 'Agriculture essentials', nameAr: 'مستلزمات زراعية', countUnit: 'PIECE',
    template: {
      VARIETY: 'HIDDEN', HYBRID: 'HIDDEN', COUNTRY_OF_ORIGIN: 'HIDDEN', VENDOR: 'REQUIRED',
      LOT_NUMBER: 'HIDDEN', MANUFACTURING_DATE: 'HIDDEN', EXPIRY: 'HIDDEN', SHELF_LIFE: 'HIDDEN',
    },
  },
} as const satisfies Record<string, { nameEn: string; nameAr: string; countUnit: CountUnit; template: Template }>;

const isAttribute = (value: string): value is ProductAttribute => (PRODUCT_ATTRIBUTES as readonly string[]).includes(value);
const isMode = (value: string): value is AttributeMode => (ATTRIBUTE_MODES as readonly string[]).includes(value);

/** A complete template from stored rows. Missing attributes are hidden. */
export function templateFrom(rows: readonly { attribute: string; mode: string }[]): Template {
  const template: Record<ProductAttribute, AttributeMode> = Object.fromEntries(
    PRODUCT_ATTRIBUTES.map((a) => [a, 'HIDDEN']),
  ) as Record<ProductAttribute, AttributeMode>;
  for (const { attribute, mode } of rows) {
    if (isAttribute(attribute) && isMode(mode)) template[attribute] = mode;
  }
  return template;
}

export const expiryTracked = (template: Template): boolean => template.EXPIRY !== 'HIDDEN';

/** CAT-016: a shelf life only pre-fills an expiry date, so it cannot be shown where expiry is hidden. */
export function assertValidTemplate(template: Template): void {
  if (!expiryTracked(template) && template.SHELF_LIFE !== 'HIDDEN') {
    throw new DomainError('INVALID_TEMPLATE', { attribute: 'SHELF_LIFE', requires: 'EXPIRY' });
  }
}

export type Hybrid = 'HYBRID' | 'NON_HYBRID';

/** The templated attributes a product itself carries. The rest are captured on batches at receipt. */
export type ProductAttributes = {
  readonly hybrid: Hybrid | null;
  readonly countryOfOrigin: string | null;
  readonly vendorId: string | null;
  readonly shelfLifeMonths: number | null;
};

const PRODUCT_FIELDS = [
  ['HYBRID', 'hybrid'],
  ['COUNTRY_OF_ORIGIN', 'countryOfOrigin'],
  ['VENDOR', 'vendorId'],
  ['SHELF_LIFE', 'shelfLifeMonths'],
] as const satisfies readonly (readonly [ProductAttribute, keyof ProductAttributes])[];

/**
 * CAT-013: the type's template decides what a product must and may carry. A
 * hidden attribute is dropped rather than refused: the form never shows it, and
 * a template changed later must not make old products unsaveable.
 */
export function applyTemplate(template: Template, input: Partial<ProductAttributes>): ProductAttributes {
  const out: Record<keyof ProductAttributes, unknown> = { hybrid: null, countryOfOrigin: null, vendorId: null, shelfLifeMonths: null };
  for (const [attribute, field] of PRODUCT_FIELDS) {
    const mode = template[attribute];
    if (mode === 'HIDDEN') continue;
    const value = input[field] ?? null;
    if (mode === 'REQUIRED' && value === null) throw new DomainError('ATTRIBUTE_REQUIRED', { attribute });
    out[field] = value;
  }
  return out as ProductAttributes;
}

/** CAT-001: whether a product of this type is organised into varieties. */
export const usesVarieties = (template: Template): boolean => template.VARIETY !== 'HIDDEN';

/** A SKU sits under a variety when the type requires one, and never when it hides them. */
export function assertSkuVariety(template: Template, varietyId: string | null): void {
  if (template.VARIETY === 'REQUIRED' && varietyId === null) throw new DomainError('ATTRIBUTE_REQUIRED', { attribute: 'VARIETY' });
  if (template.VARIETY === 'HIDDEN' && varietyId !== null) throw new DomainError('ATTRIBUTE_NOT_ALLOWED', { attribute: 'VARIETY' });
}
