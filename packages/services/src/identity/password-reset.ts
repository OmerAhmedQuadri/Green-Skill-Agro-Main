import { assertPasswordAcceptable, DomainError, normaliseEmail, type UserId } from '@gsa/core';
import { loadConfig } from '@gsa/config';
import { schema } from '@gsa/db';
import { and, eq, isNull } from 'drizzle-orm';
import { enqueueEmail } from '../notifications';
import { hitRateLimit, writeAudit } from '../platform';
import { getDb } from '../runtime';
import { hashPassword } from './password';
import { revokeAllSessions } from './sessions';
import { newSessionToken, resetTokenIdFor } from './tokens';

const { users, passwordResetTokens } = schema;
const RESET_LINK_MS = 30 * 60_000;
const HOUR = 60 * 60_000;

type Meta = { readonly ip: string | null; readonly requestId: string; readonly now: Date };

/**
 * Emails a single-use, 30-minute reset link (ADR-0018). Always completes the
 * same way, whether or not the address belongs to anyone — the response must
 * never reveal which accounts exist (SECURITY §1).
 */
export async function requestPasswordReset(input: { email: string }, meta: Meta): Promise<void> {
  const db = getDb();
  let email: string;
  try {
    email = normaliseEmail(input.email);
  } catch {
    return;
  }
  await hitRateLimit(db, `password-reset:ip:${meta.ip ?? 'unknown'}`, 10, HOUR, meta.now);
  await hitRateLimit(db, `password-reset:email:${email}`, 3, HOUR, meta.now);

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user || user.status !== 'ACTIVE') return;

  const token = newSessionToken();
  const link = `${loadConfig().APP_URL.replace(/\/+$/, '')}/reset-password?token=${token}`;
  await db.transaction(async (tx) => {
    // One live link at a time: an earlier unused link stops working.
    await tx.update(passwordResetTokens).set({ usedAt: meta.now })
      .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));
    await tx.insert(passwordResetTokens).values({
      id: resetTokenIdFor(token), userId: user.id, createdAt: meta.now,
      expiresAt: new Date(meta.now.getTime() + RESET_LINK_MS), requestedIp: meta.ip,
    });
    // Queued in this transaction: no token row, no email (ADR-0023).
    await enqueueEmail(tx, {
      to: email, template: 'password-reset', locale: user.locale, params: { name: user.name, link }, branchId: user.branchId,
    }, meta.now);
    await writeAudit(tx, { actorId: user.id, branchId: user.branchId, requestId: meta.requestId, ip: meta.ip }, {
      action: 'identity.password_reset_requested', entityType: 'user', entityId: user.id,
    });
  });
}

/** Consumes a reset link: sets the new password and ends every session (SECURITY §1). */
export async function resetPasswordWithToken(input: { token: string; newPassword: string }, meta: Meta): Promise<void> {
  const db = getDb();
  await hitRateLimit(db, `password-reset-use:ip:${meta.ip ?? 'unknown'}`, 20, 60_000, meta.now);
  const id = resetTokenIdFor(input.token);
  const [row] = await db.select({ token: passwordResetTokens, user: users })
    .from(passwordResetTokens).innerJoin(users, eq(users.id, passwordResetTokens.userId))
    .where(eq(passwordResetTokens.id, id));
  if (!row || row.token.usedAt || row.token.expiresAt.getTime() <= meta.now.getTime() || row.user.status !== 'ACTIVE') {
    throw new DomainError('RESET_LINK_INVALID');
  }
  const { user } = row;
  assertPasswordAcceptable(input.newPassword, [user.email, user.phone, user.name]);
  const passwordHash = await hashPassword(input.newPassword);

  await db.transaction(async (tx) => {
    // Single use, enforced by the statement that consumes it.
    const consumed = await tx.update(passwordResetTokens).set({ usedAt: meta.now })
      .where(and(eq(passwordResetTokens.id, id), isNull(passwordResetTokens.usedAt))).returning({ id: passwordResetTokens.id });
    if (consumed.length === 0) throw new DomainError('RESET_LINK_INVALID');
    await tx.update(users)
      .set({ passwordHash, mustChangePassword: false, failedSignIns: 0, lockedUntil: null, updatedAt: meta.now })
      .where(eq(users.id, user.id));
    await revokeAllSessions(tx, user.id as UserId);
    await writeAudit(tx, { actorId: user.id, branchId: user.branchId, requestId: meta.requestId, ip: meta.ip }, {
      action: 'identity.password_reset_completed', entityType: 'user', entityId: user.id,
    });
  });
}
