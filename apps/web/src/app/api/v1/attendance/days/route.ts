import { attendance as contract } from '@gsa/contracts';
import { attendance } from '@gsa/services';
import { mutation } from '@/server/route';

/** ATT-011: open a seller's day on their behalf, with a reason. */
export const POST = mutation(contract.OpenDayRequest, async ({ ctx, input }) => ({
  status: 201, body: await attendance.openDayOnBehalf(ctx, input),
}));
