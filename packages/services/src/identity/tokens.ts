import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { loadConfig } from '@gsa/config';

/** 256 random bits; lives only in the httpOnly cookie (ADR-0018). */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores: an HMAC of the token, keyed by SESSION_SECRET. */
export function sessionIdFor(token: string): string {
  return createHmac('sha256', loadConfig().SESSION_SECRET).update(token).digest('hex');
}

// No look-alike characters (0/O, 1/l/I): temporary passwords are read aloud or retyped.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function newTemporaryPassword(length = 14): string {
  return Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}
