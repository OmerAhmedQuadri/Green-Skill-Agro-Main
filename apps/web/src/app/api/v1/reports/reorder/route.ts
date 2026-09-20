import { reports } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** RPT-004..006: what the projection suggests ordering, and the workings behind it. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await reports.listRecommendations(ctx)));
