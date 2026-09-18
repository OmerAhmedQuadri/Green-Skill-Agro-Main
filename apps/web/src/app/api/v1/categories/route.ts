import { catalogue as contract } from '@gsa/contracts';
import { catalogue } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ ctx }) => Response.json(await catalogue.listCategories(ctx)));

export const POST = mutation(contract.CreateCategoryRequest, async ({ ctx, input }) => ({
  status: 201, body: await catalogue.createCategory(ctx, input),
}));
