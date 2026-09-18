import { inventory as contract } from '@gsa/contracts';
import { inventory } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** STK-003: GET /batches?lot=… — LOT numbers stay searchable. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.LotSearchQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await inventory.searchLots(ctx, query.lot));
});
