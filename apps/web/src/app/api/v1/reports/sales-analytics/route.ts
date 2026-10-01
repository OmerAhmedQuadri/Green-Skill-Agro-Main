import { reports as contract } from '@gsa/contracts';
import { reports } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** ADR-0048: a view of sales — totals, the run over time, and who, where and what — net of returns, live. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.SalesAnalyticsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await reports.salesAnalytics(ctx, query));
});
