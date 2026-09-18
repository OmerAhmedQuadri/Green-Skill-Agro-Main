import { DomainError } from '@gsa/core';

/**
 * Keyset cursors for lists sorted by something other than the id, e.g. a name
 * (CONVENTIONS §5). Opaque to the client.
 */
export function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function decodeCursor(cursor: string, length: number): string[] {
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parts) && parts.length === length && parts.every((p) => typeof p === 'string')) return parts;
  } catch { /* fall through */ }
  throw new DomainError('INVALID_CURSOR');
}

export const pageLimit = (limit: number | undefined, fallback = 50): number => Math.min(Math.max(limit ?? fallback, 1), 200);

/** Escapes LIKE wildcards in user input. */
export const likePattern = (search: string): string => `%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
