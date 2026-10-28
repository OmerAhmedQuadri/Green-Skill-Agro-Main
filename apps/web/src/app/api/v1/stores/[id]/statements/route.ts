import { stores } from '@gsa/services';
import { z } from 'zod';
import { authedRoute, mutation } from '@/server/route';

type P = { id: string };
const Empty = z.object({});

/** IMP-010: the store's latest statements. */
export const GET = authedRoute<P>(async ({ ctx, params }) => Response.json(await stores.listStoreStatements(ctx, params.id)));

/** IMP-010: a statement of the account as it stands now — numbered at once, printed by the worker. */
export const POST = mutation<typeof Empty, P>(Empty, async ({ ctx, params }) => ({
  status: 201, body: await stores.requestStoreStatement(ctx, params.id),
}));
