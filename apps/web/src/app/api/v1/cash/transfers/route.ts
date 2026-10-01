import { cash as contract } from '@gsa/contracts';
import { stores } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** ADR-0046: store bank transfers nobody has checked yet, oldest first — for whoever approves settlements. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListTransfersQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await stores.listAwaitingTransfers(ctx, query));
});
