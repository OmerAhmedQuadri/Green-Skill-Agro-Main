import { procurement as contract } from '@gsa/contracts';
import { procurement } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** RCV-002: validates an uploaded spreadsheet and returns each row with its error. Writes nothing. */
export const POST = mutation<typeof contract.ReceiptPreviewRequest, P>(contract.ReceiptPreviewRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await procurement.previewReceiptImport(ctx, params.id, input),
}));
