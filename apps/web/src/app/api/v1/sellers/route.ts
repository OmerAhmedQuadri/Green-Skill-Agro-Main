import { vehicles } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** Active sellers and their vehicles, for assigning (VEH-002) and opening days (ATT-011). */
export const GET = authedRoute(async ({ ctx }) => Response.json(await vehicles.listSellers(ctx)));
