import { media as contract } from '@gsa/contracts';
import { media } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

/** SYS-013 (ADR-0049): what is stored, kind by kind, against the budget. Super Admin only. */
export const GET = authedRoute(async ({ ctx }) => Response.json(await media.storageOverview(ctx)));

/** SYS-010, SYS-012: new periods or budget; refused with STORAGE_CONFIRM_DELETES until confirmed when it deletes files. */
export const PATCH = mutation(contract.SetStoragePolicyRequest, async ({ ctx, input }) => ({
  status: 200, body: await media.setStoragePolicy(ctx, input),
}));
