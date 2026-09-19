import { sales as contract } from '@gsa/contracts';
import { sales } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** PRC-013: `:id` is the sale. The first decision wins; four-eyes. */
export const POST = mutation<typeof contract.DecideDiscountRequest, P>(contract.DecideDiscountRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await sales.decideDiscountRequest(ctx, params.id, input),
}));
