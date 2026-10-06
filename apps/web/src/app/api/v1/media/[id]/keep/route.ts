import { media as contract } from '@gsa/contracts';
import { media } from '@gsa/services';
import { mutation } from '@/server/route';

/** SYS-011: keep one file forever, or hand it back to the storage policy. */
export const PUT = mutation<typeof contract.KeepFileRequest, { id: string }>(contract.KeepFileRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await media.keepFile(ctx, params.id, input.keep),
}));
