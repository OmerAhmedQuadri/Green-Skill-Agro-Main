import { warehouse as contract } from '@gsa/contracts';
import { inventory } from '@gsa/services';
import { mutation } from '@/server/route';

type P = { id: string };

/** EXP-006, `inventory.manage_expiry`: put a batch first in line for clearance. */
export const PUT = mutation<typeof contract.ClearancePriorityRequest, P>(contract.ClearancePriorityRequest, async ({ ctx, params, input }) => {
  await inventory.setClearancePriority(ctx, params.id, input);
  return { status: 200, body: { batchId: params.id, prioritised: input.prioritised } };
});
