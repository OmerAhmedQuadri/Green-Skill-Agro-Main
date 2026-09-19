import { vehicles as contract } from '@gsa/contracts';
import { vehicles } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

/** VEH-001, STK-006: the register — each vehicle, its seller and what it carries. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await vehicles.listVehicles(ctx)));

export const POST = mutation(contract.CreateVehicleRequest, async ({ ctx, input }) => ({
  status: 201, body: await vehicles.createVehicle(ctx, input),
}));
