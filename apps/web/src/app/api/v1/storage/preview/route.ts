import { media as contract } from '@gsa/contracts';
import { media } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** SYS-012: what the next run would delete if these periods were saved. Reads only. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const periods = contract.PreviewStoragePolicyQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await media.previewStoragePolicy(ctx, { periods }));
});
