import { inventory as contract } from '@gsa/contracts';
import { inventory } from '@gsa/services';
import { authedRoute } from '@/server/route';

export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListStockQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await inventory.listStock(ctx, query));
});
