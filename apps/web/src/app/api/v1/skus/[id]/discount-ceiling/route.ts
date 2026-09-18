import { pricing as contract } from '@gsa/contracts';
import { pricing } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** PRC-005: a SKU's own ceiling; null returns it to the default. */
export const PUT = mutation<typeof contract.SetSkuCeilingRequest, P>(contract.SetSkuCeilingRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await pricing.setSkuDiscountCeiling(ctx, params.id, input.ceiling),
}));
