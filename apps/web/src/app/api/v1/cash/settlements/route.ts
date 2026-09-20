import { cash as contract } from '@gsa/contracts';
import { cash } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

/** Newest first: a seller's own settlements, or everyone's for approvers and cash viewers. */
export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListSettlementsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await cash.listSettlements(ctx, query));
});

/** CSH-002, CSH-003, CSH-005: declared with its photo; nothing leaves cash in hand until a manager approves. */
export const POST = mutation(contract.SubmitSettlementRequest, async ({ ctx, input }) => ({ status: 201, body: await cash.submitSettlement(ctx, input) }));
