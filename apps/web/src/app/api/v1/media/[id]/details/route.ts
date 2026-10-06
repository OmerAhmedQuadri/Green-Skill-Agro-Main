import { media } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** ADR-0049: a file's page — what it is, how long it is kept, or when it was deleted. */
export const GET = authedRoute<{ id: string }>(async ({ ctx, params }) => Response.json(await media.fileDetails(ctx, params.id)));
