import { vehicles as contract } from '@gsa/contracts';
import { vehicles } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** VEH-002, VEH-009: empty, it passes at once; carrying stock, it becomes a handover both sellers confirm. */
export const POST = mutation<typeof contract.AssignVehicleRequest, P>(contract.AssignVehicleRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await vehicles.assignVehicle(ctx, params.id, input),
}));
