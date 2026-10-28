import { corrections as contract } from '@gsa/contracts';
import { corrections } from '@gsa/services';
import { mutation } from '@/server/route';

/** COR-006: correct a sale made in the app, in the caller's open correction session. */
export const POST = mutation<typeof contract.SaleCorrectionRequest, { id: string }>(
  contract.SaleCorrectionRequest,
  async ({ ctx, input, params }) => ({ status: 201, body: await corrections.correctSale(ctx, params.id, input) }),
);
