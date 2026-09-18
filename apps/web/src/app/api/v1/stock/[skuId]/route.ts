import { inventory } from '@gsa/services';
import { authedRoute } from '@/server/route';

type P = { skuId: string };

/** STK-001: one SKU's stock, batch by batch. */
export const GET = authedRoute<P>(async ({ ctx, params }) => Response.json(await inventory.getSkuStock(ctx, params.skuId)));
