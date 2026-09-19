import { stores as contract } from '@gsa/contracts';
import { stores } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

/** A seller's portfolio, or every store with `stores.view_all` — each with its credit status. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListStoresQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await stores.listStores(ctx, query));
});

/** Workflow H: a likely duplicate answers 409 DUPLICATE_STORE_WARNING until acknowledged (STO-008). */
export const POST = mutation(contract.OnboardStoreRequest, async ({ ctx, input }) => ({
  status: 201, body: await stores.onboardStore(ctx, input),
}));
