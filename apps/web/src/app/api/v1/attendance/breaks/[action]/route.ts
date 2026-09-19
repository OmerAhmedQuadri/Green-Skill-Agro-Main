import { DomainError } from '@gsa/core';
import { attendance } from '@gsa/services';
import { z } from 'zod';
import { mutation } from '@/server/route';

type P = { action: string };
const Empty = z.object({});

/** ATT-003: `start` or `end`, where the Admin has enabled breaks. */
export const POST = mutation<typeof Empty, P>(Empty, async ({ ctx, params }) => {
  if (params.action !== 'start' && params.action !== 'end') throw new DomainError('NOT_FOUND', { entity: 'action', id: params.action });
  return { status: 200, body: await attendance.setBreak(ctx, params.action) };
});
