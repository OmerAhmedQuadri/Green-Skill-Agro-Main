import { vehicles as contract } from '@gsa/contracts';
import { vehicles } from '@gsa/services';
import { mutation } from '@/server/route';

/** STK-012: stock back from a vehicle, posted as it arrives. */
export const POST = mutation(contract.VehicleReturnRequest, async ({ ctx, input }) => ({
  status: 201, body: await vehicles.recordVehicleReturn(ctx, input),
}));
