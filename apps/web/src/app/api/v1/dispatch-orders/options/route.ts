import { dispatch as contract } from '@gsa/contracts';
import { dispatch } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** DSP-002: the store's credit first, then every priced item with what the warehouse holds. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const { storeId } = contract.DispatchOptionsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await dispatch.dispatchOptions(ctx, storeId));
});
