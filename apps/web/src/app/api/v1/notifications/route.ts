import { notifications as contract } from '@gsa/contracts';
import { notifications } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** The bell (ADR-0034): polled every 30 s. Any signed-in user; only their own. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListNotificationsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await notifications.listMyNotifications(ctx, query));
});
