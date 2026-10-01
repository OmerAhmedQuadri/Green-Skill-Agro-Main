import { cash as contract } from '@gsa/contracts';
import { stores } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** ADR-0046: confirmed, it counts towards the seller's commission; not received, the store owes it again. */
export const POST = mutation<typeof contract.DecideTransferRequest, P>(contract.DecideTransferRequest,
  async ({ ctx, params, input }) => ({ status: 200, body: await stores.decideTransfer(ctx, params.id, input) }));
