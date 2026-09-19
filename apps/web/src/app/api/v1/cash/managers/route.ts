import { cash } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** CSH-003: the managers a seller can hand cash to. */
export const GET = authedRoute(async ({ ctx }) => Response.json({ items: await cash.handoverManagers(ctx) }));
