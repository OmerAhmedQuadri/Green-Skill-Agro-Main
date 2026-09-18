import { z } from 'zod';
import { identity } from '@gsa/services';
import { mutation } from '@/server/route';

// The temporary password is returned once and never stored for replay (SECURITY §5).
export const POST = mutation<z.ZodObject, { id: string }>(z.object({}), async ({ ctx, params }) => {
  const reset: { temporaryPassword: string | null } = await identity.resetAccountPassword(ctx, params.id);
  return { status: 200, body: reset, replayBody: { temporaryPassword: null } };
});
