import { procurement } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** PO-004, STK-007: what is on its way, kept apart from stock. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await procurement.listIncoming(ctx)));
