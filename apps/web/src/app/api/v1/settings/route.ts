import { system as contract } from '@gsa/contracts';
import { system } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

export const GET = authedRoute(async ({ ctx }) => Response.json(await system.getSettings(ctx)));

export const PATCH = mutation(contract.UpdateSettingsRequest, async ({ ctx, input }) => ({
  status: 200, body: await system.updateSettings(ctx, input.changes),
}));
