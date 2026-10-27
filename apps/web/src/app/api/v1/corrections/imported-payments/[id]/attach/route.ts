import { corrections as contract } from '@gsa/contracts';
import { corrections } from '@gsa/services';
import { mutation } from '@/server/route';

/** COR-005: attach an imported payment to its store, in the caller's open correction session. */
export const POST = mutation<typeof contract.AttachImportedPaymentRequest, { id: string }>(contract.AttachImportedPaymentRequest, async ({ ctx, params, input }) => {
  await corrections.attachImportedPayment(ctx, params.id, input);
  return { status: 200, body: { ok: true } };
});
