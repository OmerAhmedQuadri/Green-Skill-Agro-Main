import { stores } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** IMP-005: an imported store's sales and payments not in its account yet, and what they come to. */
export const GET = authedRoute<{ id: string }>(async ({ ctx, params }) => Response.json(await stores.importedHistory(ctx, params.id)));
