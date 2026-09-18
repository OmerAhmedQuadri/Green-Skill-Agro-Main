import { procurement as contract } from '@gsa/contracts';
import { DomainError } from '@gsa/core';
import { procurement } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string; action: string };

/** STATE-MACHINES §1: POST /purchase-orders/:id/transitions/:action — submit, approve, place, despatch… */
export const POST = mutation<typeof contract.TransitionRequest, P>(contract.TransitionRequest, async ({ ctx, params, input }) => {
  const action = contract.PoAction.safeParse(params.action.replace(/-/g, '_'));
  if (!action.success) throw new DomainError('NOT_FOUND', { entity: 'transition', action: params.action });
  return { status: 200, body: await procurement.transitionPurchaseOrder(ctx, params.id, action.data, input) };
});
