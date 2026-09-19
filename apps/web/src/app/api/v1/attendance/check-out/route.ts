import { attendance as contract } from '@gsa/contracts';
import { attendance } from '@gsa/services';
import { mutation } from '@/server/route';

/** Workflow G step 7 (ATT-001, 002). */
export const POST = mutation(contract.CheckOutRequest, async ({ ctx, input }) => ({
  status: 200, body: await attendance.checkOut(ctx, input),
}));
