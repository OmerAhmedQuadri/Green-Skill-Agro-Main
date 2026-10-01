import { reports } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** ADR-0048: what the sales view's filters offer. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await reports.analyticsOptions(ctx)));
