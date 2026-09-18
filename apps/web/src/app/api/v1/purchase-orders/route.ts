import { procurement as contract } from '@gsa/contracts';
import { procurement } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListPurchaseOrdersQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await procurement.listPurchaseOrders(ctx, query));
});

export const POST = mutation(contract.CreatePurchaseOrderRequest, async ({ ctx, input }) => ({
  status: 201, body: await procurement.createPurchaseOrder(ctx, input),
}));
