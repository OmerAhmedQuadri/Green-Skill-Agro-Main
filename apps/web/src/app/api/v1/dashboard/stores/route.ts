import { reports as contract } from '@gsa/contracts';
import { reports } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** RPT-016 (ADR-0054): the dashboard's stores tab. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.DashboardStoresQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await reports.dashboardStores(ctx, query));
});
