import { sales as contract } from '@gsa/contracts';
import { sales } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** SAL-001..005, CRD-005: the store's credit first, then what the vehicle can sell and at what price. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const { storeId } = contract.SaleOptionsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await sales.saleOptions(ctx, storeId));
});
