import {
  afterFailedSignIn, DomainError, isLocked, parseSignInIdentifier, type Role, type UserId,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import { hitRateLimit, writeAudit } from '../platform';
import { defaultBranchId, getDb } from '../runtime';
import { verifyPassword, timingEqualiserHash } from './password';
import { createSession, revokeSession, type SessionMeta } from './sessions';
import { resolveSession } from './request-context';

const { users } = schema;

export type SignInResult = {
  readonly token: string;
  readonly user: { readonly id: UserId; readonly role: Role; readonly locale: 'en' | 'ar'; readonly mustChangePassword: boolean };
};

type Meta = SessionMeta & { readonly requestId: string };

const MINUTE = 60_000;

/**
 * ADR-0018 / SECURITY §1. Failure bookkeeping (rate limits, failure count,
 * lockout, audit) is committed even though the attempt is refused, so it runs
 * outside the success transaction.
 */
export async function signIn(input: { identifier: string; password: string }, meta: Meta): Promise<SignInResult> {
  const db = getDb();
  const parsed = parseSignInIdentifier(input.identifier);
  const idKey = parsed?.value ?? input.identifier.trim().toLowerCase().slice(0, 254);

  await hitRateLimit(db, `sign-in:ip:${meta.ip ?? 'unknown'}`, 20, MINUTE, meta.now);
  await hitRateLimit(db, `sign-in:id:${idKey}`, 5, MINUTE, meta.now);

  const [user] = parsed
    ? await db.select().from(users).where(parsed.kind === 'email' ? eq(users.email, parsed.value) : eq(users.phone, parsed.value))
    : [];
  const origin = {
    actorId: user?.id ?? null,
    branchId: user?.branchId ?? (await defaultBranchId()),
    requestId: meta.requestId,
    ip: meta.ip,
  };
  const refuse = async (reason: string, code: 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED' | 'ACCOUNT_DEACTIVATED', details = {}) => {
    await writeAudit(db, origin, {
      action: 'identity.sign_in_refused', entityType: 'user', entityId: user?.id ?? null, after: { identifier: idKey, reason },
    });
    return new DomainError(code, details);
  };

  if (!user) {
    await verifyPassword(await timingEqualiserHash(), input.password);
    throw await refuse('UNKNOWN_ACCOUNT', 'INVALID_CREDENTIALS');
  }
  if (isLocked(user.lockedUntil, meta.now)) {
    throw await refuse('LOCKED', 'ACCOUNT_LOCKED', { lockedUntil: user.lockedUntil?.toISOString() });
  }
  if (!(await verifyPassword(user.passwordHash, input.password))) {
    await db.update(users).set(afterFailedSignIn(user.failedSignIns, meta.now)).where(eq(users.id, user.id));
    throw await refuse('WRONG_PASSWORD', 'INVALID_CREDENTIALS');
  }
  // Checked only after the password, so deactivation isn't revealed to guessers.
  if (user.status !== 'ACTIVE') throw await refuse('DEACTIVATED', 'ACCOUNT_DEACTIVATED');

  return db.transaction(async (tx) => {
    await tx.update(users).set({ failedSignIns: 0, lockedUntil: null }).where(eq(users.id, user.id));
    const token = await createSession(tx, user.id as UserId, meta);
    await writeAudit(tx, origin, { action: 'identity.sign_in', entityType: 'user', entityId: user.id });
    return {
      token,
      user: { id: user.id as UserId, role: user.role, locale: user.locale, mustChangePassword: user.mustChangePassword },
    };
  });
}

export async function signOut(token: string | undefined, meta: Meta): Promise<void> {
  if (!token) return;
  const session = await resolveSession(token, meta);
  const db = getDb();
  await revokeSession(db, token);
  if (session) {
    const { ctx } = session;
    await writeAudit(db, { actorId: ctx.user.id, branchId: ctx.branchId, requestId: ctx.requestId, ip: ctx.ip }, {
      action: 'identity.sign_out', entityType: 'user', entityId: ctx.user.id,
    });
  }
}
