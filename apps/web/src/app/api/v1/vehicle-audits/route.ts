import { vehicles as contract } from '@gsa/contracts';
import { vehicles } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

/** VEH-011: audits, newest first. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListAuditsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json({ items: await vehicles.listVehicleAudits(ctx, query) });
});

/** VEH-011, VEH-014: a manager opens the count on a vehicle. */
export const POST = mutation(contract.OpenAuditRequest, async ({ ctx, input }) => ({ status: 201, body: await vehicles.openVehicleAudit(ctx, input) }));
