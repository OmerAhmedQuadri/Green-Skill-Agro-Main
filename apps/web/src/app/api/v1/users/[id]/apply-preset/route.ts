import { identity as contract } from '@gsa/contracts';
import { identity } from '@gsa/services';
import { mutation } from '@/server/route';

export const POST = mutation<typeof contract.ApplyPresetRequest, { id: string }>(contract.ApplyPresetRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await identity.applyPresetToAccount(ctx, params.id, input.preset),
}));
