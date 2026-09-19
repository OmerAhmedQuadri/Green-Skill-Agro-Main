import { z } from 'zod';
import { Limit, OptionalText } from './shared';

/** Workflow L (RET-001..012, ADR-0039): against one sale, batch by batch; `saleable` false writes the packs off. */
export const RecordReturnRequest = z.object({
  saleId: z.uuid(),
  kind: z.enum(['CREDIT_NOTE', 'REPLACEMENT']),
  condition: z.enum(['UNCLEARED_PAYMENT', 'DEFECTIVE']),
  lines: z.array(z.object({
    saleLineId: z.uuid(), batchId: z.uuid(), packs: z.number().int().min(1).max(100_000), saleable: z.boolean().optional(),
  })).min(1).max(200),
  note: OptionalText(500),
  warehouseId: z.uuid().nullable().optional(),
});
export const ListReturnsQuery = z.object({
  saleId: z.uuid().optional(), storeId: z.uuid().optional(), sellerId: z.uuid().optional(),
  cursor: z.string().max(500).optional(), limit: Limit.optional(),
});
/** RET-009 */
export const SalesMonthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), sellerId: z.uuid().optional() });
