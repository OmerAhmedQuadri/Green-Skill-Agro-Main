import { corrections } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** COR-006: the store's imported invoices that stand, with their lines, for the Super Admin to correct. */
export const GET = authedRoute<{ id: string }>(async ({ ctx, params }) => Response.json(await corrections.listImportedSales(ctx, params.id)));
