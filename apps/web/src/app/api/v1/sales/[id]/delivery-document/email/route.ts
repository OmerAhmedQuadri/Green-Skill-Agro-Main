import { sales as contract } from '@gsa/contracts';
import { sales } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** DOC-003: emailed with the PDF attached, through the outbox. */
export const POST = mutation<typeof contract.EmailDocumentRequest, P>(contract.EmailDocumentRequest, async ({ ctx, params, input }) => {
  await sales.emailDeliveryDocument(ctx, params.id, input);
  return { status: 200, body: await sales.getSale(ctx, params.id) };
});
