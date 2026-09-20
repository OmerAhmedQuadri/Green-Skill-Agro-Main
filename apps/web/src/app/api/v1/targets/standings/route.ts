import { targets as contract } from '@gsa/contracts';
import { targets } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** COM-004, COM-007: where each seller the viewer may see stands this month. */
export const GET = authedRoute(async ({ ctx, request }) => {
  const { period } = contract.PeriodQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json({ items: await targets.listStandings(ctx, period) });
});
