import { reports as contract } from '@gsa/contracts';
import { reports } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** RPT-013 (ADR-0054): the dashboard's team tab, for a day. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.DashboardTeamQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await reports.dashboardTeam(ctx, query));
});
