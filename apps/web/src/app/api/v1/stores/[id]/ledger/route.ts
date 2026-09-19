import { stores } from '@gsa/services';
import { authedRoute } from '@/server/route';

type P = { id: string };

/** RPT-008, CRD-003 */
export const GET = authedRoute<P>(async ({ ctx, params }) => Response.json(await stores.listStoreLedger(ctx, params.id)));
