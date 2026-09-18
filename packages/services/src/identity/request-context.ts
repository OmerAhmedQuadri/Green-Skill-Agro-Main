import { effectivePermissions, isSessionLive, SESSION_TOUCH_MS, type BranchId, type UserId } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { getDb } from '../runtime';
import { loadOverrides } from './permission-store';
import { sessionIdFor } from './tokens';

const { sessions, users } = schema;

export type RequestMeta = { readonly requestId: string; readonly ip: string | null; readonly now: Date };
export type ResolvedSession = { readonly ctx: Ctx; readonly mustChangePassword: boolean };

/**
 * Turns a session cookie into a request context (ARCHITECTURE §6.1).
 * Permissions are re-read on every request, so a change applies on the user's
 * next request (USR-010) and deactivation is immediate.
 */
export async function resolveSession(token: string | undefined, meta: RequestMeta): Promise<ResolvedSession | null> {
  if (!token) return null;
  const db = getDb();
  const id = sessionIdFor(token);
  const [row] = await db
    .select({
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      role: users.role,
      status: users.status,
      locale: users.locale,
      branchId: users.branchId,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id));

  if (!row) return null;
  if (row.status !== 'ACTIVE' || !isSessionLive(row, row.role, meta.now)) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  if (meta.now.getTime() - row.lastSeenAt.getTime() > SESSION_TOUCH_MS) {
    await db.update(sessions).set({ lastSeenAt: meta.now }).where(eq(sessions.id, id));
  }

  const userId = row.userId as UserId;
  const permissions = effectivePermissions(row.role, await loadOverrides(db, userId));
  return {
    mustChangePassword: row.mustChangePassword,
    ctx: {
      user: { id: userId, role: row.role },
      permissions,
      now: meta.now,
      requestId: meta.requestId,
      locale: row.locale,
      branchId: row.branchId as BranchId,
      ip: meta.ip,
    },
  };
}
