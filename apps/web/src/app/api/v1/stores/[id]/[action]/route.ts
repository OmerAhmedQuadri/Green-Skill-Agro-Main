import { stores as contract } from '@gsa/contracts';
import { DomainError } from '@gsa/core';
import { stores } from '@gsa/services';
import { z } from 'zod';
import { mutation } from '@/server/route';

type P = { id: string; action: string };
const Body = z.record(z.string(), z.unknown());

/** STATE-MACHINES §4: `approve` and `reject` (STO-009, four-eyes); `status` to deactivate or reactivate. */
export const POST = mutation<typeof Body, P>(Body, async ({ ctx, params, input }) => {
  switch (params.action) {
    case 'approve': case 'reject':
      return { status: 200, body: await stores.decideStore(ctx, params.id, params.action, contract.DecideStoreRequest.parse(input)) };
    case 'status':
      return { status: 200, body: await stores.setStoreActive(ctx, params.id, contract.StoreActiveRequest.parse(input)) };
    default: throw new DomainError('NOT_FOUND', { entity: 'action', id: params.action });
  }
});
