import { z } from 'zod';

/** RPT-001: the dimensions a trend can be cut by. */
export const TrendDimension = z.enum(['PRODUCT', 'SKU', 'SELLER', 'STORE', 'CATEGORY']);

export const TrendsQuery = z.object({
  dimension: TrendDimension.optional(),
  /** RPT-001 month on month, RPT-002 against the same month last season. */
  compare: z.enum(['PREVIOUS', 'YEAR_AGO']).optional(),
  months: z.coerce.number().int().min(1).max(36).optional(),
});

/** RPT-005, PO-008: a recommendation becomes a DRAFT order the manager then edits. */
export const ConvertToDraftRequest = z.object({
  vendorId: z.uuid(),
  lines: z.array(z.object({
    skuId: z.uuid(),
    packs: z.coerce.number().int().min(1).max(1_000_000),
  })).min(1).max(200),
});
