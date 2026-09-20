import { reports as contract } from '@gsa/contracts';
import { reports } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** RPT-001, RPT-002: month on month and year on year, by the chosen dimension. */
export const GET = authedRoute(async ({ ctx, request }) => {
  const query = contract.TrendsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await reports.salesTrends(ctx, query));
});
