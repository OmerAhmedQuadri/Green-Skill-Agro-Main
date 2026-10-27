import { corrections as contract } from '@gsa/contracts';
import { corrections } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** IMP-009: what the history import could not settle — open, or resolved. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListImportWarningsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await corrections.listImportWarnings(ctx, query));
});
