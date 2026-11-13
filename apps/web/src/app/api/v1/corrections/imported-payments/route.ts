import { corrections } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** IMP-009: imported payments nobody could place, not attached yet. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await corrections.listUnassignedPayments(ctx)));
