import { media, system } from '@gsa/services';
import { z } from 'zod';
import { mutation } from '@/server/route';

const Body = z.object({});

/** ADR-0050: back up now — the worker takes it up within seconds. One at a time, ten minutes apart. */
export const POST = mutation(Body, async ({ ctx }) => {
  await system.requestBackup(ctx);
  return { status: 200, body: await media.storageOverview(ctx) };
});
