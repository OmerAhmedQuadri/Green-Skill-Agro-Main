import { cash as contract } from '@gsa/contracts';
import { cash } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** CSH-004..007: approval moves the money; a different amount or a rejection needs a comment. */
export const POST = mutation<typeof contract.DecideSettlementRequest, P>(contract.DecideSettlementRequest,
  async ({ ctx, params, input }) => ({ status: 200, body: await cash.decideSettlement(ctx, params.id, input) }));
