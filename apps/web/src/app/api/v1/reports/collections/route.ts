import { reports as contract } from '@gsa/contracts';
import { reports } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** RPT-008 (ADR-0048): collected in the period by seller and method, and what each store owes now, aged. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.CollectionsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await reports.collectionsView(ctx, query));
});
