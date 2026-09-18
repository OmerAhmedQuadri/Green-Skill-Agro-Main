import { vendors as contract } from '@gsa/contracts';
import { vendors } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListVendorsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await vendors.listVendors(ctx, query));
});

export const POST = mutation(contract.CreateVendorRequest, async ({ ctx, input }) => ({
  status: 201, body: await vendors.createVendor(ctx, input),
}));
