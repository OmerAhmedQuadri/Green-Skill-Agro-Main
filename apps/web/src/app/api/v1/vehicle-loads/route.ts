import { vehicles as contract } from '@gsa/contracts';
import { vehicles } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListLoadsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await vehicles.listLoads(ctx, query));
});

/** Workflow F (VEH-005, 006): over the ceiling, answered 409 CEILING_WARNING until acknowledged. */
export const POST = mutation(contract.IssueLoadRequest, async ({ ctx, input }) => ({
  status: 201, body: await vehicles.issueLoad(ctx, input),
}));
