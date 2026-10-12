import { reports as contract } from '@gsa/contracts';
import { reports } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** RPT-012 (ADR-0054): the dashboard's sales tab. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.DashboardSalesQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await reports.dashboardSales(ctx, query));
});
