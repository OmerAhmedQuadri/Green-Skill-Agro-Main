import { notifications as contract } from '@gsa/contracts';
import { notifications } from '@gsa/services';
import { mutation } from '@/server/route';

export const POST = mutation(contract.MarkReadRequest, async ({ ctx, input }) => ({
  status: 200, body: await notifications.markNotificationsRead(ctx, input),
}));
