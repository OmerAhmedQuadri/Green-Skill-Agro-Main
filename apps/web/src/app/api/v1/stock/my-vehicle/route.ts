import { vehicles } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** USR-013, EXP-007: my vehicle's stock, with expiry indicators. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await vehicles.getMyVehicle(ctx)));
