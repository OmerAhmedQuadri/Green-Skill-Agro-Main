import { catalogue as contract } from '@gsa/contracts';
import { catalogue } from '@gsa/services';
import { authedRoute } from '@/server/route';

export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListSkusQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await catalogue.listSkus(ctx, query));
});
