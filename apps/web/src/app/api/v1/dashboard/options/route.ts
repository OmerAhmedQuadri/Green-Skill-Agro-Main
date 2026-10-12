import { reports } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** ADR-0054: the reader's dashboard tabs, and what their filters can choose from. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await reports.dashboardOptions(ctx)));
