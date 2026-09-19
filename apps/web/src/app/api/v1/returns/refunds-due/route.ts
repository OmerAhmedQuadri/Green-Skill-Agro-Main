import { returns } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** OQ-012: money a manager's credit note left owed to a store, for the seller to hand over. */
export const GET = authedRoute(async ({ ctx }) => Response.json({ items: await returns.myRefundsDue(ctx) }));
