import { media as contract } from '@gsa/contracts';
import { media, system } from '@gsa/services';
import { mutation } from '@/server/route';

/** ADR-0050: pause the nightly backup through a day (at most 30 on), or lift the pause with null. */
export const PUT = mutation(contract.PauseBackupsRequest, async ({ ctx, input }) => {
  await system.pauseBackups(ctx, input.until);
  return { status: 200, body: await media.storageOverview(ctx) };
});
