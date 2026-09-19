import { warehouse as contract } from '@gsa/contracts';
import { inventory } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** WRO-004, four-eyes: approve (optionally fewer packs) or reject with a comment. */
export const POST = mutation<typeof contract.DecideWriteOffRequest, P>(contract.DecideWriteOffRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await inventory.decideWriteOffRequest(ctx, params.id, input),
}));
