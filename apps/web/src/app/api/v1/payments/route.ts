import { stores as contract } from '@gsa/contracts';
import { stores } from '@gsa/services';
import { mutation } from '@/server/route';

/** CRD-003: collected from a store, oldest debts settled first. */
export const POST = mutation(contract.PaymentRequest, async ({ ctx, input }) => ({
  status: 201, body: await stores.recordPayment(ctx, input),
}));
