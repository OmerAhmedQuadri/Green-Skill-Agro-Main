import { pricing as contract } from '@gsa/contracts';
import { pricing } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ ctx }) => Response.json(await pricing.listPriceLists(ctx)));

export const POST = mutation(contract.CreatePriceListRequest, async ({ ctx, input }) => ({
  status: 201, body: await pricing.createPriceList(ctx, input),
}));
