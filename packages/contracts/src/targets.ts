import { z } from 'zod';
import { MoneyString } from './shared';

/** TGT-002: a Riyadh calendar month. */
export const Period = z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const Count = z.string().trim().regex(/^\d{1,7}$/);

/**
 * TGT-003: any combination of the four figures. A figure left out is not part
 * of that seller's month; core refuses a target with nothing set at all.
 */
export const SetTargetRequest = z.object({
  sellerId: z.uuid(),
  period: Period,
  goals: z.object({
    REVENUE: MoneyString.optional(),
    PACKS_SOLD: Count.optional(),
    NEW_STORES: Count.optional(),
    COLLECTED: MoneyString.optional(),
  }),
  note: z.string().trim().max(500).nullable().optional(),
});

export const PeriodQuery = z.object({ period: Period.optional() });
