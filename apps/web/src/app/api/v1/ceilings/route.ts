import { system as contract } from '@gsa/contracts';
import { system } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ ctx }) => Response.json(await system.getCeilings(ctx)));

export const PUT = mutation(contract.SetCeilingRequest, async ({ ctx, input }) => ({
  status: 200, body: await system.setCeiling(ctx, input),
}));
