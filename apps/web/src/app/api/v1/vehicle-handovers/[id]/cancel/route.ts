import { vehicles as contract } from '@gsa/contracts';
import { vehicles } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

export const POST = mutation<typeof contract.CancelRequest, P>(contract.CancelRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await vehicles.cancelHandover(ctx, params.id, input),
}));
