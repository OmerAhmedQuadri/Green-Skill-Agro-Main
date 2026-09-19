import { vehicles as contract } from '@gsa/contracts';
import { vehicles } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

type P = { id: string };

export const GET = authedRoute<P>(async ({ ctx, params }) => Response.json(await vehicles.getVehicle(ctx, params.id)));

/** VEH-001, VEH-004: a corrected odometer is a new reading with a note. */
export const PATCH = mutation<typeof contract.UpdateVehicleRequest, P>(contract.UpdateVehicleRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await vehicles.updateVehicle(ctx, params.id, input),
}));
