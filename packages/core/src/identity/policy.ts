import { DomainError } from '../errors';
import type { Role } from './roles';

/**
 * Account and session rules (ADR-0018, SECURITY §1). Pure — the clock is a
 * parameter.
 */

// ---------------------------------------------------------------- passwords
export const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 256;

// Frequently breached passwords of qualifying length, plus obvious local ones.
const COMMON_PASSWORDS = new Set([
  'password12', 'password123', 'password1234', '1234567890', '0123456789', '12345678910', '123456789a',
  'qwertyuiop', 'qwerty1234', 'qwerty12345', 'asdfghjkl1', '1q2w3e4r5t', '1qaz2wsx3edc', 'zaq12wsxcde',
  'iloveyou12', 'princess12', 'sunshine12', 'football12', 'basketball', 'letmein123', 'welcome123',
  'welcome1234', 'admin12345', 'administrator', 'changeme123', 'passw0rd123', 'p@ssw0rd123',
  'abc1234567', 'abcdefghij', 'aaaaaaaaaa', 'trustno1234', 'superman123', 'michael123', 'computer12',
  'riyadh1234', 'riyadh12345', 'saudi12345', 'ksa1234567', 'mohammed123', 'mohammad123', 'ahmed12345',
  'greenagro1', 'greenagro12', 'greenagro123', 'greenagro2026', 'green12345',
]);

export type PasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'COMMON' | 'REPETITIVE' | 'CONTAINS_IDENTIFIER';

/** Length and a common-password check; no composition rules (SECURITY §1). */
export function passwordProblem(password: string, identifiers: readonly (string | null | undefined)[] = []): PasswordProblem | null {
  if (password.length < PASSWORD_MIN_LENGTH) return 'TOO_SHORT';
  if (password.length > PASSWORD_MAX_LENGTH) return 'TOO_LONG';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'COMMON';
  if (/^(.)\1+$/u.test(password)) return 'REPETITIVE';
  for (const id of identifiers) {
    const stem = id?.split('@')[0]?.replace(/^\+/, '').toLowerCase();
    if (stem && stem.length >= 4 && lower.includes(stem)) return 'CONTAINS_IDENTIFIER';
  }
  return null;
}

export function assertPasswordAcceptable(password: string, identifiers: readonly (string | null | undefined)[] = []): void {
  const problem = passwordProblem(password, identifiers);
  if (problem) throw new DomainError('PASSWORD_TOO_WEAK', { reason: problem, minLength: PASSWORD_MIN_LENGTH });
}

// ---------------------------------------------------------------- identifiers
export function normaliseEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new DomainError('INVALID_EMAIL', { email });
  return value;
}

/** Saudi mobiles in any common local form become E.164 (+9665XXXXXXXX). */
export function normalisePhone(phone: string): string {
  const compact = phone.replace(/[\s\-().]/g, '');
  const saudi = /^(?:\+966|00966|966|0)?(5\d{8})$/.exec(compact);
  if (saudi?.[1]) return `+966${saudi[1]}`;
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  throw new DomainError('INVALID_PHONE', { phone });
}

/** Sign-in accepts an email or a phone number (ADR-0018). */
export function parseSignInIdentifier(identifier: string): { kind: 'email' | 'phone'; value: string } | null {
  try {
    return identifier.includes('@')
      ? { kind: 'email', value: normaliseEmail(identifier) }
      : { kind: 'phone', value: normalisePhone(identifier) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- sessions
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const SESSION_ABSOLUTE_MS = 30 * DAY;
/** Refresh last-seen at most once a minute, to avoid a write on every request. */
export const SESSION_TOUCH_MS = 60_000;

export function sessionIdleMs(role: Role): number {
  return role === 'SUPER_ADMIN' || role === 'ADMIN' ? 12 * HOUR : 7 * DAY;
}

export function isSessionLive(
  session: { readonly lastSeenAt: Date; readonly expiresAt: Date },
  role: Role,
  now: Date,
): boolean {
  if (now.getTime() >= session.expiresAt.getTime()) return false;
  return now.getTime() - session.lastSeenAt.getTime() <= sessionIdleMs(role);
}

// ---------------------------------------------------------------- lockout
export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_MS = 15 * 60_000;

export function isLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}

/** Ten consecutive failures lock the account for fifteen minutes, then the count restarts. */
export function afterFailedSignIn(failedSignIns: number, now: Date): { failedSignIns: number; lockedUntil: Date | null } {
  const failures = failedSignIns + 1;
  return failures >= LOCKOUT_THRESHOLD
    ? { failedSignIns: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) }
    : { failedSignIns: failures, lockedUntil: null };
}
