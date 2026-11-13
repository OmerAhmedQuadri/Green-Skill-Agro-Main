import { corrections as contract } from '@gsa/contracts';
import { corrections } from '@gsa/services';
import { mutation } from '@/server/route';

/** COR-002, COR-005: correct one entry of a store's account, in the caller's open correction session. */
export const POST = mutation<typeof contract.StoreCorrectionRequest, { id: string }>(
  contract.StoreCorrectionRequest,
  async ({ ctx, input, params }) => ({ status: 201, body: await corrections.correctStoreEntry(ctx, params.id, input) }),
);
