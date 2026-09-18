import { identity as contract } from '@gsa/contracts';
import { identity } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

type P = { id: string };

export const GET = authedRoute<P>(async ({ ctx, params }) => Response.json(await identity.getAccount(ctx, params.id)));

export const PATCH = mutation<typeof contract.UpdateAccountRequest, P>(contract.UpdateAccountRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await identity.updateAccount(ctx, params.id, input),
}));
