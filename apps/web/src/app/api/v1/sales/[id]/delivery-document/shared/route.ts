import { sales } from '@gsa/services';
import { z } from 'zod';
import { mutation } from '@/server/route';

type P = { id: string };
const Body = z.object({});

/** DOC-003, OQ-007: the phone's share sheet completed. */
export const POST = mutation<typeof Body, P>(Body, async ({ ctx, params }) => {
  await sales.recordDocumentShared(ctx, params.id);
  return { status: 200, body: await sales.getSale(ctx, params.id) };
});
