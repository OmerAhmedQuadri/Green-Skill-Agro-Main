import { cash } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** CSH-001, SAL-007: the seller's own cash in hand. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await cash.getMyCashInHand(ctx)));
