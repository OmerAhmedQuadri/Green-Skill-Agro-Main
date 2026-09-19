import { z } from 'zod';
import { Limit, OptionalText, PercentString, QueryBoolean, Version } from './shared';

/** Workflow J, K (DSP-001..003, DSP-015): the same lines as a sale; above the ceiling, a reason. */
export const RaiseDispatchRequest = z.object({
  storeId: z.uuid(),
  lines: z.array(z.object({ skuId: z.uuid(), packs: z.number().int().min(1).max(100_000), discount: PercentString.optional() })).min(1).max(100),
  approvalReason: OptionalText(500),
});
export const DispatchOptionsQuery = z.object({ storeId: z.uuid() });
export const DispatchStoresQuery = z.object({ search: z.string().trim().max(100).optional() });
export const ListDispatchQuery = z.object({
  status: z.enum(['REQUESTED', 'BEING_HANDLED', 'RELEASED', 'DELIVERED', 'CLOSED']).optional(),
  open: QueryBoolean.optional(), unconfirmed: QueryBoolean.optional(), cursor: z.string().max(500).optional(), limit: Limit.optional(),
});

export const VersionRequest = z.object({ version: Version });
/** DSP-006 */
export const ReleaseDispatchRequest = z.object({ version: Version, transportSlipPhotoId: z.uuid(), transportNote: OptionalText(300) });
export const CancelDispatchRequest = z.object({ version: Version, reason: z.string().trim().min(1).max(500) });
/** DSP-009..011 */
export const ReceiptRequest = z.object({
  version: Version, mode: z.enum(['IN_PERSON', 'OWNER_WORD']),
  lines: z.array(z.object({ lineId: z.uuid(), received: z.number().int().min(0), short: z.number().int().min(0), damaged: z.number().int().min(0) })).min(1).max(100),
  payment: z.object({ method: z.enum(['CASH', 'BANK_TRANSFER']), reference: OptionalText(100) }).nullable().optional(),
});
/** DSP-012 */
export const ResolveShortfallRequest = z.object({ version: Version, resolution: z.enum(['FROM_VEHICLE', 'FURTHER_ORDER', 'NOT_NEEDED']) });
/** DSP-013 */
export const LostClaimRequest = z.object({ version: Version, reason: z.string().trim().min(1).max(500) });
export const DecideLostClaimRequest = z.object({ version: Version, approve: z.boolean(), comment: OptionalText(500) });
