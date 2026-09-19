import { stores as contract } from '@gsa/contracts';
import { stores } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** CRD-001, OQ-010 */
export const PATCH = mutation<typeof contract.CreditCycleRequest, P>(contract.CreditCycleRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await stores.setCreditCycle(ctx, params.id, input),
}));
