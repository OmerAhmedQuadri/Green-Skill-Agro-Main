import { describe, expect, it } from 'vitest';
import {
  afterFailedSignIn, isLocked, isSessionLive, normalisePhone, parseSignInIdentifier, passwordProblem,
} from './policy';

const t0 = new Date('2026-09-18T09:00:00Z');
const plus = (ms: number) => new Date(t0.getTime() + ms);

describe('password policy (SECURITY §1)', () => {
  it('requires at least 10 characters, with no composition rules', () => {
    expect(passwordProblem('short1!')).toBe('TOO_SHORT');
    expect(passwordProblem('correct horse battery')).toBeNull();
  });
  it('rejects common and repetitive passwords', () => {
    expect(passwordProblem('Password123')).toBe('COMMON');
    expect(passwordProblem('GreenAgro123')).toBe('COMMON');
    expect(passwordProblem('zzzzzzzzzzzz')).toBe('REPETITIVE');
  });
  it('rejects passwords containing the sign-in identifier', () => {
    expect(passwordProblem('omar.farooq-2026', ['omar.farooq@example.com'])).toBe('CONTAINS_IDENTIFIER');
  });
});

describe('sign-in identifiers (ADR-0018)', () => {
  it('normalises Saudi mobiles in every common form to E.164', () => {
    for (const form of ['0501234567', '501234567', '+966501234567', '00966501234567', '050 123 4567']) {
      expect(normalisePhone(form)).toBe('+966501234567');
    }
  });
  it('accepts email or phone and lower-cases email', () => {
    expect(parseSignInIdentifier(' Seller@Example.COM ')).toEqual({ kind: 'email', value: 'seller@example.com' });
    expect(parseSignInIdentifier('0501234567')).toEqual({ kind: 'phone', value: '+966501234567' });
    expect(parseSignInIdentifier('not an identifier')).toBeNull();
  });
});

describe('session lifetime (ADR-0018)', () => {
  const session = { lastSeenAt: t0, expiresAt: plus(30 * 86_400_000) };
  it('sellers and managers idle out after 7 days; admins after 12 hours', () => {
    expect(isSessionLive(session, 'SELLER', plus(6 * 86_400_000))).toBe(true);
    expect(isSessionLive(session, 'SELLER', plus(8 * 86_400_000))).toBe(false);
    expect(isSessionLive(session, 'ADMIN', plus(11 * 3_600_000))).toBe(true);
    expect(isSessionLive(session, 'ADMIN', plus(13 * 3_600_000))).toBe(false);
  });
  it('no session outlives its absolute expiry, however active', () => {
    expect(isSessionLive({ lastSeenAt: plus(30 * 86_400_000 - 1000), expiresAt: plus(30 * 86_400_000) }, 'SELLER', plus(30 * 86_400_000))).toBe(false);
  });
});

describe('lockout (SECURITY §1)', () => {
  it('ten consecutive failures lock the account for 15 minutes', () => {
    expect(afterFailedSignIn(8, t0)).toEqual({ failedSignIns: 9, lockedUntil: null });
    const locked = afterFailedSignIn(9, t0);
    expect(locked.failedSignIns).toBe(0);
    expect(isLocked(locked.lockedUntil, plus(14 * 60_000))).toBe(true);
    expect(isLocked(locked.lockedUntil, plus(15 * 60_000))).toBe(false);
  });
});
