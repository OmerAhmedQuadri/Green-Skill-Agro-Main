import { vehicles } from '@gsa/services';
import { z } from 'zod';
import { mutation } from '@/server/route';

type P = { id: string };
const Empty = z.object({});

/** VEH-009: each seller confirms on their own phone; the second confirmation completes it. */
export const POST = mutation<typeof Empty, P>(Empty, async ({ ctx, params }) => ({
  status: 200, body: await vehicles.confirmHandover(ctx, params.id),
}));
