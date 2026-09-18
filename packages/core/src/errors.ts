/**
 * Stable, catalogued error codes. The client translates `code` through the
 * message files; the server never builds user-facing text (ARCHITECTURE §6.9).
 * Adding a code means adding its `en` and `ar` messages.
 */
export type ErrorCode =
  | 'INVALID_MONEY'
  | 'INVALID_QUANTITY'
  | 'INVALID_PERCENT'
  | 'INVALID_PACK_COUNT'
  | 'INVALID_PACK_SIZE'
  | 'PART_PACK_NOT_ALLOWED'
  | 'FORBIDDEN'
  | 'ACCOUNT_TIER_FORBIDDEN'
  | 'PERMISSION_NOT_CONFIGURABLE'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, details: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
