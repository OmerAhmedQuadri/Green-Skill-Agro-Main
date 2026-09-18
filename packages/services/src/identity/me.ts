import { assertPasswordAcceptable, DomainError, type PermissionCode, type Role, type UserId } from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { audit, hitRateLimit, inTx } from '../platform';
import { getDb } from '../runtime';
import { hashPassword, verifyPassword } from './password';
import { createSession, revokeAllSessions, type SessionMeta } from './sessions';

const { users } = schema;

export type Me = {
  readonly id: UserId;
  readonly role: Role;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly locale: 'en' | 'ar';
  readonly mustChangePassword: boolean;
  /** The effective set the interface renders from — absent means hidden (USR-008). */
  readonly permissions: readonly PermissionCode[];
};

async function loadSelf(ctx: Ctx) {
  const [row] = await getDb().select().from(users).where(eq(users.id, ctx.user.id));
  if (!row) throw new DomainError('UNAUTHENTICATED');
  return row;
}

export async function getMe(ctx: Ctx): Promise<Me> {
  const row = await loadSelf(ctx);
  return {
    id: ctx.user.id, role: row.role, name: row.name, email: row.email, phone: row.phone,
    locale: row.locale, mustChangePassword: row.mustChangePassword, permissions: [...ctx.permissions].sort(),
  };
}

export async function updateMyPreferences(ctx: Ctx, input: { locale: 'en' | 'ar' }): Promise<void> {
  await getDb().update(users).set({ locale: input.locale, updatedAt: ctx.now }).where(eq(users.id, ctx.user.id));
}

/**
 * Changing a password ends every other session and rotates this one
 * (SECURITY §1). Returns the new session token.
 */
export async function changeMyPassword(
  ctx: Ctx, input: { currentPassword: string; newPassword: string }, meta: SessionMeta,
): Promise<{ token: string }> {
  await hitRateLimit(getDb(), `password-change:${ctx.user.id}`, 5, 60_000, ctx.now);
  const user = await loadSelf(ctx);
  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) throw new DomainError('INVALID_CREDENTIALS');
  assertPasswordAcceptable(input.newPassword, [user.email, user.phone, user.name]);
  if (await verifyPassword(user.passwordHash, input.newPassword)) {
    throw new DomainError('PASSWORD_TOO_WEAK', { reason: 'SAME_AS_CURRENT' });
  }
  const passwordHash = await hashPassword(input.newPassword);
  return inTx(ctx, async (tx) => {
    await tx.update(users).set({ passwordHash, mustChangePassword: false, updatedAt: ctx.now }).where(eq(users.id, ctx.user.id));
    await revokeAllSessions(tx, ctx.user.id);
    const token = await createSession(tx, ctx.user.id, meta);
    await audit(tx, ctx, { action: 'identity.password_changed', entityType: 'user', entityId: ctx.user.id });
    return { token };
  });
}
