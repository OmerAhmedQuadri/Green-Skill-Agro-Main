import { z } from 'zod';
import { returns } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };
const Body = z.object({});

/** OQ-012: the seller hands the money over, out of their cash in hand. */
export const POST = mutation<typeof Body, P>(Body, async ({ ctx, params }) => ({ status: 200, body: { items: await returns.payRefundDue(ctx, params.id) } }));
