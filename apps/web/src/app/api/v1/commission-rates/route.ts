import { system } from '@gsa/services';
import { authedRoute } from '@/server/route';

export const GET = authedRoute(async ({ ctx }) => Response.json(await system.getCommissionRates(ctx)));
