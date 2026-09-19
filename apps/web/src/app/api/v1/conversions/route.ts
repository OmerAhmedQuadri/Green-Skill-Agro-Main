import { warehouse as contract } from '@gsa/contracts';
import { inventory } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ request, ctx }) => {
  const cursor = new URL(request.url).searchParams.get('cursor') ?? undefined;
  return Response.json(await inventory.listConversions(ctx, { cursor }));
});

/** Workflow D: one balanced conversion; no approval step (CNV-008). */
export const POST = mutation(contract.ConvertStockRequest, async ({ ctx, input }) => ({
  status: 201, body: await inventory.convertStock(ctx, input),
}));
