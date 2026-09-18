import { pricing as contract } from '@gsa/contracts';
import { pricing } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ ctx }) => Response.json(await pricing.getDiscountCeilings(ctx)));

export const PUT = mutation(contract.SetDiscountCeilingsRequest, async ({ ctx, input }) => ({
  status: 200, body: await pricing.setDiscountCeilings(ctx, input),
}));
