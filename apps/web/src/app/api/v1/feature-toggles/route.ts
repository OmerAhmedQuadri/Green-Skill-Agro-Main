import { system as contract } from '@gsa/contracts';
import { system } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ ctx }) => Response.json(await system.getToggles(ctx)));

export const PATCH = mutation(contract.UpdateTogglesRequest, async ({ ctx, input }) => ({
  status: 200, body: await system.updateToggles(ctx, input.changes),
}));
