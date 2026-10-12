import { reports as contract } from '@gsa/contracts';
import { reports } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** RPT-015 (ADR-0054): the dashboard's stock tab. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.DashboardStockQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await reports.dashboardStock(ctx, query));
});
