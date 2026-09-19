import { inventory } from '@gsa/services';
import { authedRoute } from '@/server/route';

type P = { id: string };

export const GET = authedRoute<P>(async ({ ctx, params }) => Response.json(await inventory.getWriteOff(ctx, params.id)));
