import { procurement } from '@gsa/services';
import { getTranslations } from 'next-intl/server';
import { authedRoute } from '@/server/route';

type P = { id: string };

/** RCV-001: the bulk receipt template, pre-filled with the order's outstanding lines, headed in the user's language. */
export const GET = authedRoute<P>(async ({ ctx, params }) => {
  const t = await getTranslations({ locale: ctx.locale, namespace: 'receiving.columns' });
  const labels = Object.fromEntries(procurement.RECEIPT_COLUMNS.map((c) => [c, t(c)])) as Record<procurement.ReceiptColumn, string>;
  const file = await procurement.receiptTemplate(ctx, params.id, labels);
  return new Response(new Uint8Array(file.content), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${file.fileName}"`,
      'cache-control': 'no-store',
    },
  });
});
