import { corrections as contract } from '@gsa/contracts';
import { corrections } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** COR-002: what a correction would move, before it is confirmed — made and rolled back; nothing is kept. */
export const GET = authedRoute<{ id: string }>(async ({ request, ctx, params }) => {
  const query = contract.StoreCorrectionPreviewQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await corrections.previewStoreCorrection(ctx, params.id, query));
});
