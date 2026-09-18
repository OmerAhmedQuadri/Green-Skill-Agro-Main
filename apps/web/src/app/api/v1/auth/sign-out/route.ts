import { identity } from '@gsa/services';
import { cookies } from 'next/headers';
import { publicRoute } from '@/server/route';
import { clearedSessionCookie, SESSION_COOKIE } from '@/server/session-cookie';

export const POST = publicRoute(async ({ meta }) => {
  const jar = await cookies();
  await identity.signOut(jar.get(SESSION_COOKIE)?.value, meta);
  jar.set(clearedSessionCookie());
  return new Response(null, { status: 204 });
});
