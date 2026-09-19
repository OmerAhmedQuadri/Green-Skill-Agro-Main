import { returns as contract } from '@gsa/contracts';
import { returns } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

/** Newest first: the returns on the caller's sales, or with `sales.view_all` everyone's. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListReturnsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await returns.listReturns(ctx, query));
});

/** Workflow L (RET-001..012, ADR-0039): a credit note or a defective replacement, against one sale. */
export const POST = mutation(contract.RecordReturnRequest, async ({ ctx, input }) => ({ status: 201, body: await returns.recordReturn(ctx, input) }));
