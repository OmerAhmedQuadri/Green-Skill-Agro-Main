import { stores as contract } from '@gsa/contracts';
import { stores } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** STO-007 */
export const POST = mutation<typeof contract.ReassignStoreRequest, P>(contract.ReassignStoreRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await stores.reassignStore(ctx, params.id, input),
}));
