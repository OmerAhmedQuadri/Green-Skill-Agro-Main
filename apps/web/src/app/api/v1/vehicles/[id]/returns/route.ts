import { vehicles } from '@gsa/services';
import { authedRoute } from '@/server/route';

type P = { id: string };

/** STK-012: what has come back from this vehicle. */
export const GET = authedRoute<P>(async ({ ctx, params }) => Response.json(await vehicles.listVehicleReturns(ctx, { vehicleId: params.id })));
