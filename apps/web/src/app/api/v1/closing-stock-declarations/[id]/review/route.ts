import { vehicles as contract } from '@gsa/contracts';
import { vehicles } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

export const POST = mutation<typeof contract.ReviewClosingStockRequest, P>(contract.ReviewClosingStockRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await vehicles.reviewClosingStock(ctx, params.id, input),
}));
