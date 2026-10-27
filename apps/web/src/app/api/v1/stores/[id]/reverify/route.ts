import { stores as contract } from '@gsa/contracts';
import { stores } from '@gsa/services';
import { mutation } from '@/server/route';

/** IMP-005, IMP-008: the seller re-verifies an imported store; its history goes into its account. */
export const POST = mutation<typeof contract.ReverifyStoreRequest, { id: string }>(contract.ReverifyStoreRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await stores.reverifyStore(ctx, params.id, input),
}));
