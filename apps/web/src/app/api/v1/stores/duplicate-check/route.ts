import { stores as contract } from '@gsa/contracts';
import { stores } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** STO-008 (OQ-006) */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.DuplicateCheckQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await stores.checkDuplicates(ctx, query));
});
