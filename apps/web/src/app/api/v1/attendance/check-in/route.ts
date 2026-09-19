import { attendance as contract } from '@gsa/contracts';
import { attendance } from '@gsa/services';
import { mutation } from '@/server/route';

/** Workflow G step 1 (ATT-001, 005, 007, 008). */
export const POST = mutation(contract.CheckInRequest, async ({ ctx, input }) => ({
  status: 200, body: await attendance.checkIn(ctx, input),
}));
