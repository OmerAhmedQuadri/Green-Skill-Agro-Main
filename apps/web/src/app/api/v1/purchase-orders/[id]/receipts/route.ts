import { procurement as contract } from '@gsa/contracts';
import { procurement } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** RCV-003..008: goods received against the order, line by line or from a confirmed import. */
export const POST = mutation<typeof contract.ReceiveGoodsRequest, P>(contract.ReceiveGoodsRequest, async ({ ctx, params, input }) => ({
  status: 201, body: await procurement.receiveGoods(ctx, params.id, input),
}));
