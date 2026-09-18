import { loadConfig } from '@gsa/config';
import { SESSION_ABSOLUTE_MS } from '@gsa/core';

export const SESSION_COOKIE = 'gsa_session';

/** httpOnly, SameSite=Lax, Secure over HTTPS (ADR-0010). */
export function sessionCookie(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: loadConfig().APP_URL.startsWith('https://'),
    path: '/',
    maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
  };
}

export const clearedSessionCookie = { ...sessionCookie(''), maxAge: 0 };
