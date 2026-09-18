import { vendors } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** VEN-004: the codes a product can reference — no vendor profile access needed. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await vendors.listVendorCodes(ctx)));
