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
  vendorId: z.uuid().nullable().optional(), // ADR-0045: left to the approver without vendor names
  lines: z.array(z.object({
    skuId: z.uuid(),
    packs: z.coerce.number().int().min(1).max(1_000_000),
  })).min(1).max(200),
});

/** RPT-010: a seller's own month. Absent means the current one. */
export const MyPerformanceQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });

/** ADR-0048: a view of sales — a range of Riyadh days (at most a year), and anything else it is cut by. */
export const SalesAnalyticsQuery = z.object({
  from: z.iso.date(), to: z.iso.date(),
  sellerId: z.uuid().optional(), storeId: z.uuid().optional(), vehicleId: z.uuid().optional(),
  productId: z.uuid().optional(), categoryId: z.uuid().optional(), channel: z.enum(['VEHICLE', 'DISPATCH']).optional(),
});
