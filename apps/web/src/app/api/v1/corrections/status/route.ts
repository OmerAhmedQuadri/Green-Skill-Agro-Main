import { corrections } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** COR-004: who is correcting history — polled by the console's banner. Sellers get nothing. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await corrections.correctionStatus(ctx)));
