import { attendance } from '@gsa/services';
import { z } from 'zod';
import { mutation } from '@/server/route';

type P = { id: string };
const Empty = z.object({});

/** ATT-009 */
export const POST = mutation<typeof Empty, P>(Empty, async ({ ctx, params }) => {
  await attendance.authoriseZone(ctx, params.id);
  return { status: 200, body: { ok: true } };
});
