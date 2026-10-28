import { corrections as contract } from '@gsa/contracts';
import { corrections } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** COR-002, COR-006: what an imported sale's correction would move — made and rolled back; nothing is kept. */
export const POST = authedRoute<{ id: string }>(async ({ request, ctx, params }) => {
  const input = contract.ImportedSaleCorrectionRequest.parse(await request.json());
  return Response.json(await corrections.previewImportedSaleCorrection(ctx, params.id, input));
});
