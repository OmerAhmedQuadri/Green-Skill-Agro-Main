import { z } from 'zod';
import { Limit, OptionalText, PercentString, QueryBoolean, Version } from './shared';

const Payment = z.object({ method: z.enum(['CASH', 'BANK_TRANSFER']), reference: OptionalText(100) });

/** Workflow I (SAL-001..011, PRC-009): completes within the ceilings, or — with a reason — asks for approval. */
export const RecordSaleRequest = z.object({
  storeId: z.uuid(),
  lines: z.array(z.object({ skuId: z.uuid(), packs: z.number().int().min(1).max(100_000), discount: PercentString.optional() })).min(1).max(100),
  payment: Payment.nullable().optional(),
  approvalReason: OptionalText(500),
});

export const SaleOptionsQuery = z.object({ storeId: z.uuid() });

export const ListSalesQuery = z.object({
  status: z.enum(['PENDING_DISCOUNT_APPROVAL', 'DISCOUNT_APPROVED', 'PENDING_DELIVERY', 'COMPLETED', 'CANCELLED']).optional(),
  awaitingDecision: QueryBoolean.optional(), storeId: z.uuid().optional(), sellerId: z.uuid().optional(),
  cursor: z.string().max(500).optional(), limit: Limit.optional(),
});

/** PRC-014 */
export const CompleteSaleRequest = z.object({ version: Version, payment: Payment.nullable().optional() });
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
