import { reports as contract } from '@gsa/contracts';
import { reports } from '@gsa/services';
import { mutation } from '@/server/route';

/** RPT-005, PO-008: the manager converts the advice into a DRAFT order they then edit. */
export const POST = mutation(contract.ConvertToDraftRequest, async ({ ctx, input }) => ({
  status: 201, body: await reports.convertToDraftOrder(ctx, input),
}));
