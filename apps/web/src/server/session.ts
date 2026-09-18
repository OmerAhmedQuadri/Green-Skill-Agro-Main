import { identity, type Ctx } from '@gsa/services';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { requestMeta } from './route';
import { SESSION_COOKIE } from './session-cookie';

/** One session resolution per request render (ARCHITECTURE §5). */
export const getSession = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? identity.resolveSession(token, await requestMeta()) : null;
});

export async function requireSession(opts: { allowPendingPasswordChange?: boolean } = {}): Promise<Ctx> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.mustChangePassword && !opts.allowPendingPasswordChange) redirect('/change-password');
  return session.ctx;
}

/** Where a signed-in person belongs: sellers work in the field app, everyone else in the console. */
export const homeFor = (role: Ctx['user']['role']): string => (role === 'SELLER' ? '/field/today' : '/console/dashboard');
