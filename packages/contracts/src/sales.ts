import { z } from 'zod';
import { Limit, OptionalText, PaymentTaken, PercentString, QueryBoolean, Version } from './shared';

/** Workflow I (SAL-001..011, PRC-009): completes within the ceilings, or — with a reason — asks for approval. */
export const RecordSaleRequest = z.object({
  storeId: z.uuid(),
  lines: z.array(z.object({ skuId: z.uuid(), packs: z.number().int().min(1).max(100_000), discount: PercentString.optional() })).min(1).max(100),
  /** ADR-0047: optional — part or all of what the store owes, with its voucher. */
  payment: PaymentTaken.nullable().optional(),
  approvalReason: OptionalText(500),
});

export const SaleOptionsQuery = z.object({ storeId: z.uuid() });

const SaleChannel = z.enum(['VEHICLE', 'DISPATCH']);

export const ListSalesQuery = z.object({
  status: z.enum(['PENDING_DISCOUNT_APPROVAL', 'DISCOUNT_APPROVED', 'PENDING_DELIVERY', 'COMPLETED', 'CANCELLED']).optional(),
  awaitingDecision: QueryBoolean.optional(), storeId: z.uuid().optional(), sellerId: z.uuid().optional(),
  /** ADR-0048: completed within these Riyadh days, given together; and what else a view of sales is cut by. */
  from: z.iso.date().optional(), to: z.iso.date().optional(), vehicleId: z.uuid().optional(), channel: SaleChannel.optional(),
  productId: z.uuid().optional(), categoryId: z.uuid().optional(),
  cursor: z.string().max(500).optional(), limit: Limit.optional(),
});

/** PRC-014 */
export const CompleteSaleRequest = z.object({ version: Version, payment: PaymentTaken.nullable().optional() });
/** PRC-015 */
export const WithdrawSaleRequest = z.object({ version: Version });

/** PRC-013: approve as requested, approve lower, or reject. */
export const DecideDiscountRequest = z.object({
  version: Version, approve: z.boolean(),
  lines: z.array(z.object({ lineId: z.uuid(), discount: PercentString })).max(100).optional(),
  comment: OptionalText(500),
});

/** DOC-003 */
export const EmailDocumentRequest = z.object({ to: z.string().trim().min(3).max(254) });
