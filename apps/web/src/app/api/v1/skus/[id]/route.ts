import { catalogue as contract } from '@gsa/contracts';
import { catalogue } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

export const PATCH = mutation<typeof contract.UpdateSkuRequest, P>(contract.UpdateSkuRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await catalogue.updateSku(ctx, params.id, input),
}));
