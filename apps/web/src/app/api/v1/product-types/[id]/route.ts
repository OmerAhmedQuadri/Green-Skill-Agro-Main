import { catalogue as contract } from '@gsa/contracts';
import { catalogue } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

// SYS-004: the attribute template travels with the type.
export const PATCH = mutation<typeof contract.UpdateProductTypeRequest, P>(contract.UpdateProductTypeRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await catalogue.updateProductType(ctx, params.id, input),
}));
