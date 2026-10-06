import { media as contract } from '@gsa/contracts';
import { sales } from '@gsa/services';
import { mutation } from '@/server/route';

/** SYS-011, DOC-005: keep one delivery document forever, or hand it back to the storage policy. */
export const PUT = mutation<typeof contract.KeepFileRequest, { id: string }>(contract.KeepFileRequest, async ({ ctx, params, input }) => {
  await sales.keepDeliveryDocument(ctx, params.id, input.keep);
  return { status: 200, body: await sales.getSale(ctx, params.id) };
});
