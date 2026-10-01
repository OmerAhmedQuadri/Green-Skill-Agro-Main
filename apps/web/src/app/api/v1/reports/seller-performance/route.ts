import { reports as contract } from '@gsa/contracts';
import { reports } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** RPT-010 (ADR-0048): each seller over the period; targets and commission for a whole month. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.SellerPerformanceQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await reports.sellerPerformance(ctx, query));
});
