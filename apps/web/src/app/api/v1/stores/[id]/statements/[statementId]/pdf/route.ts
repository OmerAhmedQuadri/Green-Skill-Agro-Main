import { stores } from '@gsa/services';
import { authedRoute } from '@/server/route';

type P = { id: string; statementId: string };

/** IMP-010: the printed statement. Same-origin, so the phone can share it as a file. */
export const GET = authedRoute<P>(async ({ ctx, params }) => {
  const { number, pdf } = await stores.storeStatementPdf(ctx, params.id, params.statementId);
  return new Response(pdf, {
    headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${number}.pdf"`, 'cache-control': 'private, no-store' },
  });
});
