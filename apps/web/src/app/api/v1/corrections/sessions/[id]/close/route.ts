import { corrections as contract } from '@gsa/contracts';
import { corrections } from '@gsa/services';
import { mutation } from '@/server/route';

/** COR-003: close a correction session, settling its reason. */
export const POST = mutation<typeof contract.CloseCorrectionSessionRequest, { id: string }>(
  contract.CloseCorrectionSessionRequest,
  async ({ ctx, input, params }) => ({ status: 200, body: await corrections.closeCorrectionSession(ctx, params.id, input) }),
);
