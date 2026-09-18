import { catalogue as contract } from '@gsa/contracts';
import { catalogue } from '@gsa/services';
import { authedRoute } from '@/server/route';

type P = { id: string };

/** CAT-008: the code the system proposes, before the SKU is saved. */
export const GET = authedRoute<P>(async ({ request, ctx, params }) => {
  const query = contract.SkuCodePreviewQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await catalogue.previewSkuCode(ctx, params.id, query));
});
