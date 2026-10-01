import { reports as contract } from '@gsa/contracts';
import { reports } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** RPT-010: a seller's own month — sales, collections, cash and commission in one place. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.MyPerformanceQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await reports.myPerformance(ctx, query));
});
