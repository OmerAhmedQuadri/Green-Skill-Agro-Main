import { catalogue as contract } from '@gsa/contracts';
import { catalogue } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

export const PATCH = mutation<typeof contract.UpdateVarietyRequest, P>(contract.UpdateVarietyRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await catalogue.updateVariety(ctx, params.id, input),
}));
