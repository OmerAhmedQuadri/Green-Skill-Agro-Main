import { z } from 'zod';
import { Limit, MoneyString, Version } from './shared';

/** Workflow D (CNV-001..011): any two of the three quantities; the third is derived. */
export const ConvertStockRequest = z.object({
  sourceBatchId: z.uuid(),
  targetSkuId: z.uuid(),
  sourcePacks: z.number().int().min(1).max(1_000_000).nullable().optional(),
  targetPacks: z.number().int().min(1).max(1_000_000).nullable().optional(),
  loss: z.string().trim().max(20).nullable().optional(),
  reason: z.string().trim().min(1).max(500),
  targetBasePrice: MoneyString.nullable().optional(),
});

export const WriteOffReason = z.enum(['DAMAGED', 'EXPIRED', 'SPOILED', 'MISSING', 'OTHER']);

/** Workflow E (WRO-001, WRO-002) */
export const SubmitWriteOffRequest = z.object({
  batchId: z.uuid(), packs: z.number().int().min(1).max(1_000_000), reason: WriteOffReason,
  note: z.string().trim().max(500).nullable().optional(), photoId: z.uuid(),
});

/** WRO-004: approve (as submitted or fewer packs) or reject with a comment. */
export const DecideWriteOffRequest = z.object({
  version: Version, approve: z.boolean(), approvedPacks: z.number().int().min(1).nullable().optional(),
  comment: z.string().trim().max(500).nullable().optional(),
});

export const ListWriteOffsQuery = z.object({
  status: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED']).optional(), cursor: z.uuid().optional(), limit: Limit.optional(),
});

export const ExpiryFlagsQuery = z.object({ onlyFlagged: z.enum(['true', 'false']).transform((v) => v === 'true').optional() });

export const ClearancePriorityRequest = z.object({ prioritised: z.boolean(), note: z.string().trim().max(300).nullable().optional() });
