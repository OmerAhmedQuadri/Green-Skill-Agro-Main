import { corrections as contract } from '@gsa/contracts';
import { corrections } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** COR-002, COR-006: what a sale correction would move, before it is confirmed — made and rolled back; nothing is kept. */
export const POST = authedRoute<{ id: string }>(async ({ request, ctx, params }) => {
  const input = contract.SaleCorrectionRequest.parse(await request.json());
  return Response.json(await corrections.previewSaleCorrection(ctx, params.id, input));
});
