import { attendance as contract } from '@gsa/contracts';
import { attendance } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

/** ATT-008 */
export const GET = authedRoute(async ({ ctx }) => Response.json(await attendance.listZones(ctx)));

export const POST = mutation(contract.ZoneRequest, async ({ ctx, input }) => ({
  status: 201, body: await attendance.createZone(ctx, input),
}));
