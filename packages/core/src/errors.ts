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
  | 'VERSION_CONFLICT'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_DEACTIVATED'
  | 'RATE_LIMITED'
  | 'PASSWORD_TOO_WEAK'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'INVALID_EMAIL'
  | 'INVALID_PHONE'
  | 'DUPLICATE_EMAIL'
  | 'DUPLICATE_PHONE'
  | 'CANNOT_DEACTIVATE_SELF'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'SIGN_IN_IDENTIFIER_REQUIRED'
  | 'PRESET_NOT_APPLICABLE'
  | 'MEDIA_TYPE_NOT_ALLOWED'
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_NOT_UPLOADED'
  | 'MEDIA_REJECTED'
  | 'RESET_LINK_INVALID'
  | 'INVALID_NAME'
  | 'DUPLICATE_NAME'
  | 'DUPLICATE_CODE'
  | 'DUPLICATE_SKU'
  | 'INVALID_SKU_CODE'
  | 'INVALID_VENDOR_CODE'
  | 'INVALID_COUNTRY'
  | 'INVALID_TEMPLATE'
  | 'ATTRIBUTE_REQUIRED'
  | 'ATTRIBUTE_NOT_ALLOWED'
  | 'REFERENCE_INACTIVE'
  | 'INVALID_PRICE'
  | 'CEILING_ABOVE_MAXIMUM'
  | 'INVALID_SETTING'
  | 'INVALID_CURSOR';

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
