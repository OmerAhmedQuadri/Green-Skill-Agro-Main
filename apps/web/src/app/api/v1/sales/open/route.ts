import { sales as contract } from '@gsa/contracts';
import { sales } from '@gsa/services';
import { mutation } from '@/server/route';

/**
 * ADR-0052 (SAL-012..016): an open sale. 201 COMPLETED, paid in full; or 201
 * PENDING_DISCOUNT_APPROVAL with a reason when open sales are switched off or
 * it is above the limit. Exactly once (SAL-011).
 */
export const POST = mutation(contract.RecordOpenSaleRequest, async ({ ctx, input }) => ({
  status: 201, body: await sales.recordOpenSale(ctx, input),
}));
