import { stores as contract } from '@gsa/contracts';
import { stores } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** STO-005 */
export const PATCH = mutation<typeof contract.StoreTermsRequest, P>(contract.StoreTermsRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await stores.updateStoreTerms(ctx, params.id, input),
}));
