import { catalogue as contract } from '@gsa/contracts';
import { catalogue } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

export const POST = mutation<typeof contract.CreateVarietyRequest, P>(contract.CreateVarietyRequest, async ({ ctx, params, input }) => ({
  status: 201, body: await catalogue.createVariety(ctx, params.id, input),
}));
