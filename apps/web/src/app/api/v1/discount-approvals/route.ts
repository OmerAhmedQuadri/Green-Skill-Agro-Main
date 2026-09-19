import { sales } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** PRC-012: sales waiting on a discount decision. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await sales.listSales(ctx, { awaitingDecision: true })));
