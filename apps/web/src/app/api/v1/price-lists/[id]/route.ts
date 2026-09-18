import { pricing as contract } from '@gsa/contracts';
import { pricing } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

type P = { id: string };

export const GET = authedRoute<P>(async ({ ctx, params }) => Response.json(await pricing.getPriceList(ctx, params.id)));

export const PATCH = mutation<typeof contract.UpdatePriceListRequest, P>(contract.UpdatePriceListRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await pricing.updatePriceList(ctx, params.id, input),
}));
