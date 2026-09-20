import { targets as contract } from '@gsa/contracts';
import { targets } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** TGT-004: the seller's own progress and earned commission, in real time. */
export const GET = authedRoute(async ({ ctx, request }) => {
  const { period } = contract.PeriodQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await targets.myStanding(ctx, period));
});
