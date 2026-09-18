import { identity as contract } from '@gsa/contracts';
import { identity } from '@gsa/services';
import { publicRoute } from '@/server/route';

// Consumes a single-use reset link and ends every session (ADR-0018).
export const POST = publicRoute(async ({ request, meta }) => {
  await identity.resetPasswordWithToken(contract.ResetPasswordRequest.parse(await request.json()), meta);
  return new Response(null, { status: 204 });
});
