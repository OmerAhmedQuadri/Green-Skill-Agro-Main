import { identity as contract } from '@gsa/contracts';
import { identity } from '@gsa/services';
import { cookies } from 'next/headers';
import { authedRoute } from '@/server/route';
import { sessionCookie } from '@/server/session-cookie';

// Reachable while a password change is pending; rotates the session (SECURITY §1).
export const POST = authedRoute(async ({ request, meta, ctx }) => {
  const input = contract.ChangePasswordRequest.parse(await request.json());
  const { token } = await identity.changeMyPassword(ctx, input, meta);
  (await cookies()).set(sessionCookie(token));
  return new Response(null, { status: 204 });
}, { allowPendingPasswordChange: true });
