import { ATTRIBUTE_MODES, COUNT_UNITS, PACKAGING_TYPES, PRODUCT_ATTRIBUTES } from '@gsa/core';
import { schema } from '@gsa/db';
import { describe, expect, it } from 'vitest';

// @gsa/db imports nothing from the project (ARCHITECTURE §2), so its enums
// repeat core's values. This keeps the two in step.
describe('database enums mirror core', () => {
  it('CAT-013: product attributes, attribute modes and count units', () => {
    expect(schema.productAttribute.enumValues).toEqual([...PRODUCT_ATTRIBUTES]);
    expect(schema.attributeMode.enumValues).toEqual([...ATTRIBUTE_MODES]);
    expect(schema.countUnit.enumValues).toEqual([...COUNT_UNITS]);
  });

  it('CAT-009: packaging types', () => {
    expect(schema.packagingType.enumValues).toEqual([...PACKAGING_TYPES]);
  });
});
