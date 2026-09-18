import { identity as contract } from '@gsa/contracts';
import { identity } from '@gsa/services';
import { mutation } from '@/server/route';

export const POST = mutation<typeof contract.VersionedRequest, { id: string }>(contract.VersionedRequest, async ({ ctx, params, input }) => ({
  status: 200, body: await identity.setAccountStatus(ctx, params.id, 'DEACTIVATED', input.version),
}));
