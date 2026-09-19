import { returns } from '@gsa/services';
import { authedRoute } from '@/server/route';

type P = { id: string };

/** RET-001..006: what the store still holds from the sale, what is unpaid, and each condition with its window. */
export const GET = authedRoute<P>(async ({ ctx, params }) => Response.json(await returns.getReturnable(ctx, params.id)));
