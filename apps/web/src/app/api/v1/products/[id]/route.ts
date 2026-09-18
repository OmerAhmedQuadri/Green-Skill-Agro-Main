import { catalogue as contract } from '@gsa/contracts';
import { catalogue } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

type P = { id: string };

export const GET = authedRoute<P>(async ({ ctx, params }) => Response.json(await catalogue.getProduct(ctx, params.id)));

export const PATCH = mutation<typeof contract.UpdateProductRequest, P>(contract.UpdateProductRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await catalogue.updateProduct(ctx, params.id, input),
}));
