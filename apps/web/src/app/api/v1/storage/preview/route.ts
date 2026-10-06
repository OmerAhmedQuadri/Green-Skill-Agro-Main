import { media as contract } from '@gsa/contracts';
import { media } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** SYS-012: what the next run would delete, and the next backup remove, if these periods were saved. Reads only. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const { backupRetentionDays, ...periods } = Object.fromEntries(new URL(request.url).searchParams);
  return Response.json(await media.previewStoragePolicy(ctx, {
    periods: contract.PreviewStoragePolicyQuery.parse(periods),
    backupRetentionDays: contract.PreviewBackupRetentionDays.parse(backupRetentionDays),
  }));
});
