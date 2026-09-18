import { system as contract } from '@gsa/contracts';
import { system } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { sellerId: string };

export const PUT = mutation<typeof contract.SetCommissionRateRequest, P>(contract.SetCommissionRateRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await system.setCommissionRate(ctx, params.sellerId, input.rate),
}));
