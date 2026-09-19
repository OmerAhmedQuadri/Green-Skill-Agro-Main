import { sales as contract } from '@gsa/contracts';
import { sales } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

/** A seller's own sales; with `sales.view_all`, everyone's; an approver, the requests. Newest first. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListSalesQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await sales.listSales(ctx, query));
});

/** Workflow I: 201 COMPLETED within the ceilings; 201 PENDING_DISCOUNT_APPROVAL with a reason above them (SAL-011: exactly once). */
export const POST = mutation(contract.RecordSaleRequest, async ({ ctx, input }) => ({
  status: 201, body: await sales.recordSale(ctx, input),
}));
