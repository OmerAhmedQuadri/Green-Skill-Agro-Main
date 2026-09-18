import { SESSION_ABSOLUTE_MS, type UserId } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, ne } from 'drizzle-orm';
import type { Executor } from '../platform';
import { newSessionToken, sessionIdFor } from './tokens';

const { sessions } = schema;

export type SessionMeta = { readonly ip: string | null; readonly userAgent: string | null; readonly now: Date };

/** Returns the raw token for the cookie; only its HMAC is stored. */
export async function createSession(db: Executor, userId: UserId, meta: SessionMeta): Promise<string> {
  const token = newSessionToken();
  await db.insert(sessions).values({
    id: sessionIdFor(token),
    userId,
    createdAt: meta.now,
    lastSeenAt: meta.now,
    expiresAt: new Date(meta.now.getTime() + SESSION_ABSOLUTE_MS),
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
  });
  return token;
}

export async function revokeSession(db: Executor, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionIdFor(token)));
}

/** Deactivation and password changes end every session, optionally but one (SECURITY §1). */
export async function revokeAllSessions(db: Executor, userId: UserId, exceptToken?: string): Promise<void> {
  await db.delete(sessions).where(
    exceptToken
      ? and(eq(sessions.userId, userId), ne(sessions.id, sessionIdFor(exceptToken)))
      : eq(sessions.userId, userId),
  );
}
