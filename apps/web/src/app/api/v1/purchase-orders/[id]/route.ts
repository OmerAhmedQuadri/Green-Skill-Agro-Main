import { procurement as contract } from '@gsa/contracts';
import { procurement } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

type P = { id: string };

export const GET = authedRoute<P>(async ({ ctx, params }) => Response.json(await procurement.getPurchaseOrder(ctx, params.id)));

// PO-003: only a draft is edited.
export const PATCH = mutation<typeof contract.UpdatePurchaseOrderRequest, P>(contract.UpdatePurchaseOrderRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await procurement.updatePurchaseOrder(ctx, params.id, input),
}));
