import { corrections as contract } from '@gsa/contracts';
import { corrections } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** The Corrections page: every sale correction, newest first. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListCorrectionSessionsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await corrections.listSaleCorrections(ctx, query));
});
