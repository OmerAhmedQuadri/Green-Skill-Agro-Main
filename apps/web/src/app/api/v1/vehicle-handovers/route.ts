import { vehicles } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** VEH-009: the handovers waiting on me. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await vehicles.listMyHandovers(ctx)));
