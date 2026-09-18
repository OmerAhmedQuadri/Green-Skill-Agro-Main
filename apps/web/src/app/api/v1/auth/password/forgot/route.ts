import { identity as contract } from '@gsa/contracts';
import { identity } from '@gsa/services';
import { publicRoute } from '@/server/route';

// Always 204: the answer never reveals whether an account exists (SECURITY §1).
// Exempt from Idempotency-Key like the other auth endpoints (API.md).
export const POST = publicRoute(async ({ request, meta }) => {
  await identity.requestPasswordReset(contract.ForgotPasswordRequest.parse(await request.json()), meta);
  return new Response(null, { status: 204 });
});
