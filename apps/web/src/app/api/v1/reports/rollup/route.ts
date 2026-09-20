import { z } from 'zod';
import { reports } from '@gsa/services';
import { mutation } from '@/server/route';

/** RPT-001: rebuild the rollup now rather than waiting for the hourly pass. */
export const POST = mutation(z.object({ days: z.coerce.number().int().min(1).max(400).optional() }), async ({ ctx, input }) => ({
  status: 200, body: await reports.rebuildNow(ctx, input.days ?? 2),
}));
