import { stores as contract } from '@gsa/contracts';
import { stores } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** ADR-0036: a correction or an opening balance, with a reason. */
export const POST = mutation<typeof contract.AdjustBalanceRequest, P>(contract.AdjustBalanceRequest, async ({ ctx, params, input }) => ({
  status: 201, body: await stores.adjustBalance(ctx, params.id, input),
}));
