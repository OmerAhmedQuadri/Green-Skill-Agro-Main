import { reports as contract } from '@gsa/contracts';
import { reports } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** RPT-014 (ADR-0054): the dashboard's money tab. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.DashboardMoneyQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await reports.dashboardMoney(ctx, query));
});
