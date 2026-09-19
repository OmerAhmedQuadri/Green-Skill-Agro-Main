import { dispatch as contract } from '@gsa/contracts';
import { DomainError } from '@gsa/core';
import { dispatch } from '@gsa/services';
import { z } from 'zod';
import { mutation } from '@/server/route';

type P = { id: string; action: string };
const Body = z.record(z.string(), z.unknown());

/**
 * STATE-MACHINES §3. The warehouse: `take`, `release-back`, `release`, `cancel`.
 * The seller of record: `confirm-receipt`, `resolve`, `lost-claim`. Approvers:
 * `decide-claim`. The body is checked against the action's own contract.
 */
export const POST = mutation<typeof Body, P>(Body, async ({ ctx, params, input }) => {
  const id = params.id;
  switch (params.action) {
    case 'take': return { status: 200, body: await dispatch.takeOrder(ctx, id, contract.VersionRequest.parse(input)) };
    case 'release-back': return { status: 200, body: await dispatch.releaseOrderBack(ctx, id, contract.VersionRequest.parse(input)) };
    case 'release': return { status: 200, body: await dispatch.releaseOrder(ctx, id, contract.ReleaseDispatchRequest.parse(input)) };
    case 'cancel': return { status: 200, body: await dispatch.cancelOrder(ctx, id, contract.CancelDispatchRequest.parse(input)) };
    case 'confirm-receipt': return { status: 200, body: await dispatch.confirmReceipt(ctx, id, contract.ReceiptRequest.parse(input)) };
    case 'resolve': return { status: 200, body: await dispatch.resolveShortfall(ctx, id, contract.ResolveShortfallRequest.parse(input)) };
    case 'lost-claim': return { status: 200, body: await dispatch.raiseLostClaim(ctx, id, contract.LostClaimRequest.parse(input)) };
    case 'decide-claim': return { status: 200, body: await dispatch.decideLostClaim(ctx, id, contract.DecideLostClaimRequest.parse(input)) };
    default: throw new DomainError('NOT_FOUND', { entity: 'action', id: params.action });
  }
});
