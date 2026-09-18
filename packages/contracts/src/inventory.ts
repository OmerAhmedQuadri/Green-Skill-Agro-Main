import { z } from 'zod';
import { Limit, QueryBoolean } from './shared';

export const ListStockQuery = z.object({
  search: z.string().trim().max(100).optional(), onlyHeld: QueryBoolean.optional(),
  cursor: z.string().max(500).optional(), limit: Limit.optional(),
});

/** STK-003 */
export const LotSearchQuery = z.object({ lot: z.string().trim().min(1).max(60) });
