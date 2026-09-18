import { catalogue as contract } from '@gsa/contracts';
import { catalogue } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ ctx }) => Response.json(await catalogue.listProductTypes(ctx)));

export const POST = mutation(contract.CreateProductTypeRequest, async ({ ctx, input }) => ({
  status: 201, body: await catalogue.createProductType(ctx, input),
}));
