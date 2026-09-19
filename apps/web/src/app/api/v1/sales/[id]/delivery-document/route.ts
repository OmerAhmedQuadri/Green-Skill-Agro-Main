import { sales } from '@gsa/services';
import { authedRoute } from '@/server/route';

type P = { id: string };

/** DOC-005: the kept PDF, for anyone who may see the sale. Same-origin, so the phone can share it as a file. */
export const GET = authedRoute<P>(async ({ ctx, params }) => {
  const { number, pdf } = await sales.deliveryDocumentPdf(ctx, params.id);
  return new Response(pdf, {
    headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${number}.pdf"`, 'cache-control': 'private, no-store' },
  });
});
