import { vehicles as contract } from '@gsa/contracts';
import { vehicles } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** VEH-005: `?line=<skuId>:<packs>`, repeated — FEFO batches for each, flagged first. Reads only. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const lines = new URL(request.url).searchParams.getAll('line').map((l) => {
    const [skuId, packs] = l.split(':');
    return { skuId, packs: Number(packs) };
  });
  const input = contract.LoadProposalRequest.parse({ lines });
  return Response.json(await vehicles.proposeLoad(ctx, input));
});
