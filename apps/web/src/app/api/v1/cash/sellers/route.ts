import { cash } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** CSH-001, LIM-001: what each seller is carrying — cash, stock value, and the ceilings that apply. */
export const GET = authedRoute(async ({ ctx }) => Response.json({ items: await cash.listSellerCash(ctx) }));
