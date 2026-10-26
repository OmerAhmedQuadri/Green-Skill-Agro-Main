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
  productId: z.uuid().optional(), categoryId: z.uuid().optional(),
  /** IMP-007: APP is both of the app's channels — the filter that hides imported sales; IMPORTED shows them alone. */
  channel: z.enum(['VEHICLE', 'DISPATCH', 'APP', 'IMPORTED']).optional(),
});

/** RPT-008 (ADR-0048): collections answer to the period and the seller and store filters only. */
export const CollectionsQuery = z.object({ from: z.iso.date(), to: z.iso.date(), sellerId: z.uuid().optional(), storeId: z.uuid().optional() });

/** RPT-010 (ADR-0048) */
export const SellerPerformanceQuery = z.object({ from: z.iso.date(), to: z.iso.date(), sellerId: z.uuid().optional() });

/** RPT-012 (ADR-0054): the dashboard's sales tab — every filter of the sales analytics. */
export const DashboardSalesQuery = SalesAnalyticsQuery;

/** RPT-013 (ADR-0054): the team on a day — today unless given. */
export const DashboardTeamQuery = z.object({ date: z.iso.date().optional() });

/** RPT-016 (ADR-0054): the stores — new in a period, quiet for 14, 30, 60 or 90 days, one seller's if chosen. */
export const DashboardStoresQuery = z.object({
  from: z.iso.date(), to: z.iso.date(), sellerId: z.uuid().optional(),
  quietDays: z.coerce.number().pipe(z.union([z.literal(14), z.literal(30), z.literal(60), z.literal(90)])).default(30),
});

/** RPT-014 (ADR-0054): the money — collections in a period; one seller's or one store's if chosen. */
export const DashboardMoneyQuery = CollectionsQuery;

/** RPT-015 (ADR-0054): stock, narrowed to a category or a product. */
export const DashboardStockQuery = z.object({ categoryId: z.uuid().optional(), productId: z.uuid().optional() });
