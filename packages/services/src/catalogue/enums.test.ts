import {
  ATTRIBUTE_MODES, COUNT_UNITS, PACKAGING_TYPES, PO_CLOSE_REASONS, PO_STATUSES, PRODUCT_ATTRIBUTES, STOCK_ACCOUNT_KINDS, STOCK_REFERENCE_TYPES,
  WRITE_OFF_REASONS, WRITE_OFF_STATUSES,
} from '@gsa/core';
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

  it('STK-013: stock accounts and movement references', () => {
    expect(schema.stockAccountKind.enumValues).toEqual([...STOCK_ACCOUNT_KINDS]);
    expect(schema.stockReferenceType.enumValues).toEqual([...STOCK_REFERENCE_TYPES]);
  });

  it('PO-001, PO-007: purchase order states and close reasons', () => {
    expect(schema.poStatus.enumValues).toEqual([...PO_STATUSES]);
    expect(schema.poCloseReason.enumValues).toEqual([...PO_CLOSE_REASONS]);
  });

  it('WRO-002: write-off states and reasons', () => {
    expect(schema.writeOffStatus.enumValues).toEqual([...WRITE_OFF_STATUSES]);
    expect(schema.writeOffReason.enumValues).toEqual([...WRITE_OFF_REASONS]);
  });
});
