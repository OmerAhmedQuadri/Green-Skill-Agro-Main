import { vehicles as contract } from '@gsa/contracts';
import { vehicles } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListClosingStockQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await vehicles.listClosingStock(ctx, query));
});

/** STK-010, 011: a declaration, never an adjustment. */
export const POST = mutation(contract.DeclareClosingStockRequest, async ({ ctx, input }) => ({
  status: 201, body: await vehicles.declareClosingStock(ctx, input),
}));
