import { stores } from '@gsa/services';
import { authedRoute } from '@/server/route';

type P = { id: string };

/** CRD-005: checked before any item is added. */
export const GET = authedRoute<P>(async ({ ctx, params }) => Response.json(await stores.getCreditStatus(ctx, params.id)));
