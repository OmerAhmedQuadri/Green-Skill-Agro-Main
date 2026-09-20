import { targets as contract } from '@gsa/contracts';
import { targets } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

/** TGT-001: the targets set for a month, and the way to set one. */
export const GET = authedRoute(async ({ ctx, request }) => {
  const { period } = contract.PeriodQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json({ items: await targets.listTargets(ctx, period) });
});

export const PUT = mutation(contract.SetTargetRequest, async ({ ctx, input }) => ({
  status: 200, body: await targets.setTarget(ctx, input),
}));
