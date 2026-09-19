import { system as contract } from '@gsa/contracts';
import { system } from '@gsa/services';
import { authedRoute } from '@/server/route';

/** AUD-003: Super Admin and Admin only; newest first. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListAuditLogQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await system.listAuditLog(ctx, query));
});
