import { warehouse as contract } from '@gsa/contracts';
import { inventory } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListWriteOffsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await inventory.listWriteOffs(ctx, query));
});

/** Workflow E: a report with reason and photo. Nothing moves until it is approved (WRO-003). */
export const POST = mutation(contract.SubmitWriteOffRequest, async ({ ctx, input }) => ({
  status: 201, body: await inventory.submitWriteOff(ctx, input),
}));
