import { cash } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** LIM-004: ceiling breaches the dashboard shows until they clear. */
export const GET = authedRoute(async ({ ctx }) => Response.json({ items: await cash.listFlags(ctx) }));
