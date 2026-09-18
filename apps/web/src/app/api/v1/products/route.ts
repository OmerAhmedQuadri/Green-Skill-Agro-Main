import { catalogue as contract } from '@gsa/contracts';
import { catalogue } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListProductsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await catalogue.listProducts(ctx, query));
});

export const POST = mutation(contract.CreateProductRequest, async ({ ctx, input }) => ({
  status: 201, body: await catalogue.createProduct(ctx, input),
}));
