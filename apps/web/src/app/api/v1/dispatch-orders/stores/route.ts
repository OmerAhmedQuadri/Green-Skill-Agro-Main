import { dispatch as contract } from '@gsa/contracts';
import { dispatch } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** DSP-015: active stores an order can be raised for, each with its seller. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const { search } = contract.DispatchStoresQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await dispatch.storesForOrders(ctx, search));
});
