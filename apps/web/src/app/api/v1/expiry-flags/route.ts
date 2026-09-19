import { warehouse as contract } from '@gsa/contracts';
import { inventory } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** EXP-001..008: batches with their time and rate flags, derived when read. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ExpiryFlagsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await inventory.listExpiryFlags(ctx, query));
});
