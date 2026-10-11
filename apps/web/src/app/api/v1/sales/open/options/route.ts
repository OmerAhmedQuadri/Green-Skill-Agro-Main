import { sales } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** ADR-0052: what the vehicle can sell at base prices, and whether an open sale goes through or waits. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await sales.openSaleOptions(ctx)));
