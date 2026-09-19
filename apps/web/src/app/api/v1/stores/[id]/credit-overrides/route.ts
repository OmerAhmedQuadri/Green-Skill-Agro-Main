import { stores as contract } from '@gsa/contracts';
import { stores } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** CRD-006, 007 (OQ-018): one sale, today, with a reason. */
export const POST = mutation<typeof contract.CreditOverrideRequest, P>(contract.CreditOverrideRequest, async ({ ctx, params, input }) => ({
  status: 201, body: await stores.grantCreditOverride(ctx, params.id, input),
}));
