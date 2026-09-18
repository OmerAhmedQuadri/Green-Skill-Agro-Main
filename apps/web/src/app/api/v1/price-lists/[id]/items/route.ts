import { pricing as contract } from '@gsa/contracts';
import { pricing } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

export const PUT = mutation<typeof contract.SetPriceListItemsRequest, P>(contract.SetPriceListItemsRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await pricing.setPriceListItems(ctx, params.id, input.items),
}));
