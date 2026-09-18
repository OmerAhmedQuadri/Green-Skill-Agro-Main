import { z } from 'zod';
import { media } from '@gsa/services';
import { mutation } from '@/server/route';

// Step 3: size, declared type and real type checked; anything else is deleted (SECURITY §5).
export const POST = mutation<z.ZodObject, { id: string }>(z.object({}), async ({ ctx, params }) => ({
  status: 200, body: await media.confirmUpload(ctx, params.id),
}));
