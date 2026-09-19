import { returns as contract } from '@gsa/contracts';
import { returns } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** RET-009: the month's sales, less the credit notes raised on them that month. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.SalesMonthQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await returns.mySalesMonth(ctx, query));
});
