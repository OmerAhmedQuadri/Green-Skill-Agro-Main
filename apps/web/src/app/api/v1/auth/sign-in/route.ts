import { identity as contract } from '@gsa/contracts';
import { identity } from '@gsa/services';
import { cookies } from 'next/headers';
import { publicRoute } from '@/server/route';
import { sessionCookie } from '@/server/session-cookie';

// Exempt from Idempotency-Key: a retried sign-in only creates another session (API.md).
export const POST = publicRoute(async ({ request, meta }) => {
  const input = contract.SignInRequest.parse(await request.json());
  const { token, user } = await identity.signIn(input, meta);
  const jar = await cookies();
  jar.set(sessionCookie(token));
  jar.set({ name: 'NEXT_LOCALE', value: user.locale, path: '/', sameSite: 'lax', maxAge: 31_536_000 });
  return Response.json({ user });
});
