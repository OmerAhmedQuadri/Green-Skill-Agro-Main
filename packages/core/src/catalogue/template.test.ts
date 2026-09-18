import { describe, expect, it } from 'vitest';
import { type DomainError } from '../errors';
import {
  applyTemplate, assertSkuVariety, assertValidTemplate, DEFAULT_PRODUCT_TYPES, expiryTracked, templateFrom, usesVarieties,
  type Template,
} from './template';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };
const seeds: Template = DEFAULT_PRODUCT_TYPES.SEEDS.template;
const essentials: Template = DEFAULT_PRODUCT_TYPES.ESSENTIALS.template;
const full = { hybrid: 'HYBRID', countryOfOrigin: 'IN', vendorId: 'v1', shelfLifeMonths: 24 } as const;

describe('attribute templates (CAT-013..016)', () => {
  it('CAT-014: seeds carry the full set; essentials a reduced one', () => {
    expect(usesVarieties(seeds)).toBe(true);
    expect(expiryTracked(seeds)).toBe(true);
    expect(usesVarieties(essentials)).toBe(false);
    expect(expiryTracked(essentials)).toBe(false);
    expect(essentials.VENDOR).toBe('REQUIRED');
    assertValidTemplate(seeds);
    assertValidTemplate(essentials);
  });

  it('CAT-013: a required attribute must be given', () => {
    expect(code(() => applyTemplate(seeds, { ...full, countryOfOrigin: null }))).toBe('ATTRIBUTE_REQUIRED');
    expect(applyTemplate(seeds, { ...full, shelfLifeMonths: null }).shelfLifeMonths).toBeNull(); // optional
  });

  it('CAT-013: a hidden attribute is dropped, not stored', () => {
    expect(applyTemplate(essentials, full)).toEqual({ hybrid: null, countryOfOrigin: null, vendorId: 'v1', shelfLifeMonths: null });
  });

  it('CAT-015: any attribute can be enabled on any type', () => {
    const withOrigin: Template = { ...essentials, COUNTRY_OF_ORIGIN: 'REQUIRED' };
    expect(applyTemplate(withOrigin, full).countryOfOrigin).toBe('IN');
  });

  it('CAT-016: shelf life cannot be shown where expiry is hidden', () => {
    expect(code(() => assertValidTemplate({ ...essentials, SHELF_LIFE: 'OPTIONAL' }))).toBe('INVALID_TEMPLATE');
    expect(code(() => assertValidTemplate({ ...essentials, EXPIRY: 'OPTIONAL', SHELF_LIFE: 'OPTIONAL' }))).toBe('NO_ERROR');
  });

  it('CAT-001: a SKU sits under a variety exactly when the type uses varieties', () => {
    expect(code(() => assertSkuVariety(seeds, null))).toBe('ATTRIBUTE_REQUIRED');
    expect(code(() => assertSkuVariety(essentials, 'v1'))).toBe('ATTRIBUTE_NOT_ALLOWED');
    expect(code(() => assertSkuVariety({ ...seeds, VARIETY: 'OPTIONAL' }, null))).toBe('NO_ERROR');
  });

  it('CAT-013: stored rows become a complete template; unknown rows are ignored', () => {
    const t = templateFrom([{ attribute: 'VENDOR', mode: 'REQUIRED' }, { attribute: 'COLOUR', mode: 'REQUIRED' }]);
    expect(t.VENDOR).toBe('REQUIRED');
    expect(t.VARIETY).toBe('HIDDEN');
    expect(Object.keys(t)).not.toContain('COLOUR');
  });
});
