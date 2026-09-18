import { identity as contract } from '@gsa/contracts';
import { identity } from '@gsa/services';
import { authedRoute, mutation } from '@/server/route';

type Created = { account: identity.AccountDetail; temporaryPassword: string | null };

export const GET = authedRoute(async ({ request, ctx }) => {
  const query = contract.ListAccountsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await identity.listAccounts(ctx, query));
});

// The temporary password is returned once and never stored for replay (SECURITY §5).
export const POST = mutation(contract.CreateAccountRequest, async ({ ctx, input }) => {
  const created: Created = await identity.createAccount(ctx, input);
  return { status: 201, body: created, replayBody: { ...created, temporaryPassword: null } };
});
