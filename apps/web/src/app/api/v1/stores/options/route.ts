import { stores } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** CRD-002: the credit modes offered, the active price lists, and whether approval is on. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await stores.storeOptions(ctx)));
