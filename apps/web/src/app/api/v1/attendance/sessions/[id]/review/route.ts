import { attendance as contract } from '@gsa/contracts';
import { attendance } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** ATT-012 */
export const POST = mutation<typeof contract.ReviewSessionRequest, P>(contract.ReviewSessionRequest, async ({ ctx, params, input }) => {
  await attendance.reviewSession(ctx, params.id, input);
  return { status: 200, body: { ok: true } };
});
