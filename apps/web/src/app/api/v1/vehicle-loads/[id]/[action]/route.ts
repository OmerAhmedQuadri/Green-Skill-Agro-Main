import { vehicles as contract } from '@gsa/contracts';
import { DomainError } from '@gsa/core';
import { vehicles } from '@gsa/services';
import { z } from 'zod';
import { mutation } from '@/server/route';

type P = { id: string; action: string };

/**
 * STATE-MACHINES §7: `amend` and `cancel` for the issuer; `confirm` and
 * `dispute` for the seller on their own phone (VEH-007). The body is checked
 * against the action's own contract.
 */
const Body = z.record(z.string(), z.unknown());

export const POST = mutation<typeof Body, P>(Body, async ({ ctx, params, input }) => {
  switch (params.action) {
    case 'confirm': return { status: 200, body: await vehicles.confirmLoad(ctx, params.id, contract.ConfirmLoadRequest.parse(input)) };
    case 'dispute': return { status: 200, body: await vehicles.disputeLoad(ctx, params.id, contract.DisputeLoadRequest.parse(input)) };
    case 'amend': return { status: 200, body: await vehicles.amendLoad(ctx, params.id, contract.AmendLoadRequest.parse(input)) };
    case 'cancel': return { status: 200, body: await vehicles.cancelLoad(ctx, params.id, contract.CancelRequest.parse(input)) };
    default: throw new DomainError('NOT_FOUND', { entity: 'action', id: params.action });
  }
});
