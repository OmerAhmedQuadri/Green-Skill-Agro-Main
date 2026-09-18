import { media as contract } from '@gsa/contracts';
import { media } from '@gsa/services';
import { mutation } from '@/server/route';

// Step 1: a short-lived URL the phone uploads to directly (ARCHITECTURE §6.4).
export const POST = mutation(contract.RequestUpload, async ({ ctx, input }) => ({
  status: 201,
  body: await media.requestUpload(ctx, {
    kind: input.kind, contentType: input.contentType, byteSize: input.byteSize,
    capturedAt: input.capturedAt ? new Date(input.capturedAt) : undefined, location: input.location,
  }),
}));
