import { dispatch as contract } from '@gsa/contracts';
import { dispatch } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

/** RPT-009, DSP-014: newest first; `open`, `unconfirmed` and `status` narrow it. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListDispatchQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await dispatch.listDispatchOrders(ctx, query));
});

/**
 * Workflow J and K: a seller asks for their own store (DSP-001); anyone else
 * raises it on the store's seller's behalf (DSP-015). 201 with the sale and,
 * unless it waits for a discount decision, the order.
 */
export const POST = mutation(contract.RaiseDispatchRequest, async ({ ctx, input }) => ({
  status: 201, body: ctx.user.role === 'SELLER' ? await dispatch.raiseDispatchOrder(ctx, input) : await dispatch.createOrderForSeller(ctx, input),
}));
