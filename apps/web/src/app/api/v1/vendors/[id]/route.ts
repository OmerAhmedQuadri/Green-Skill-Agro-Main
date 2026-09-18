import { vendors as contract } from '@gsa/contracts';
import { vendors } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

type P = { id: string };

export const GET = authedRoute<P>(async ({ ctx, params }) => Response.json(await vendors.getVendor(ctx, params.id)));

export const PATCH = mutation<typeof contract.UpdateVendorRequest, P>(contract.UpdateVendorRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await vendors.updateVendor(ctx, params.id, input),
}));
