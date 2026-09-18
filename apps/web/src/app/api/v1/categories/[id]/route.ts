import { catalogue as contract } from '@gsa/contracts';
import { catalogue } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

export const PATCH = mutation<typeof contract.UpdateCategoryRequest, P>(contract.UpdateCategoryRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await catalogue.updateCategory(ctx, params.id, input),
}));
