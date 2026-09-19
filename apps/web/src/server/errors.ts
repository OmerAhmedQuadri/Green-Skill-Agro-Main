import { type ErrorCode, isDomainError } from '@gsa/core';
import { ZodError } from 'zod';

/**
 * Every domain error code maps to exactly one HTTP status (ARCHITECTURE §6.9).
 * A Record over ErrorCode makes a new, unmapped code a compile error.
 */
const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  ACCOUNT_TIER_FORBIDDEN: 403,
  ACCOUNT_DEACTIVATED: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  ACCOUNT_LOCKED: 423,
  RATE_LIMITED: 429,
  INVALID_MONEY: 422,
  INVALID_QUANTITY: 422,
  INVALID_PERCENT: 422,
  INVALID_PACK_COUNT: 422,
  INVALID_PACK_SIZE: 422,
  PART_PACK_NOT_ALLOWED: 422,
  PERMISSION_NOT_CONFIGURABLE: 422,
  PRESET_NOT_APPLICABLE: 422,
  PASSWORD_TOO_WEAK: 422,
  INVALID_EMAIL: 422,
  INVALID_PHONE: 422,
  DUPLICATE_EMAIL: 422,
  DUPLICATE_PHONE: 422,
  SIGN_IN_IDENTIFIER_REQUIRED: 422,
  CANNOT_DEACTIVATE_SELF: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  IDEMPOTENCY_KEY_REQUIRED: 428,
  MEDIA_TYPE_NOT_ALLOWED: 422,
  MEDIA_TOO_LARGE: 422,
  MEDIA_NOT_UPLOADED: 409,
  MEDIA_REJECTED: 422,
  RESET_LINK_INVALID: 422,
  INVALID_NAME: 422,
  DUPLICATE_NAME: 422,
  DUPLICATE_CODE: 422,
  DUPLICATE_SKU: 422,
  INVALID_SKU_CODE: 422,
  INVALID_VENDOR_CODE: 422,
  INVALID_COUNTRY: 422,
  INVALID_TEMPLATE: 422,
  ATTRIBUTE_REQUIRED: 422,
  ATTRIBUTE_NOT_ALLOWED: 422,
  REFERENCE_INACTIVE: 422,
  INVALID_PRICE: 422,
  CEILING_ABOVE_MAXIMUM: 422,
  INVALID_SETTING: 422,
  INVALID_CURSOR: 400,
  UNBALANCED_POSTING: 422,
  INSUFFICIENT_STOCK: 409,
  INVALID_DATE: 422,
  INVALID_LOT: 422,
  INVALID_SHELF_LIFE: 422,
  EXPIRY_BEFORE_MANUFACTURE: 422,
  EXPIRY_REQUIRED: 422,
  INVALID_TRANSITION: 409,
  REASON_REQUIRED: 422,
  PO_NOT_EDITABLE: 409,
  PO_NOT_RECEIVABLE: 409,
  SKU_NOT_ON_ORDER: 422,
  INVALID_IMPORT_FILE: 422,
  INVALID_CONVERSION: 422,
  CONVERSION_UNBALANCED: 422,
  FEATURE_DISABLED: 403,
  ALREADY_DECIDED: 409,
  FOUR_EYES: 403,
  EVIDENCE_REQUIRED: 422,
};

export function problem(status: number, code: string, requestId: string, details?: Record<string, unknown>, headers?: HeadersInit): Response {
  return Response.json(
    { type: `https://greenagro.app/problems/${code.toLowerCase()}`, title: code, status, code, requestId, ...(details ? { details } : {}) },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
}

/** Messages are never built on the server — the client translates `code` (ARCHITECTURE §6.9). */
export function toProblem(error: unknown, requestId: string): Response {
  if (error instanceof ZodError) {
    return problem(400, 'VALIDATION_FAILED', requestId, {
      issues: error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
    });
  }
  if (isDomainError(error)) {
    const status = STATUS[error.code];
    const seconds = typeof error.details.retryAfterSeconds === 'number' ? error.details.retryAfterSeconds : 60;
    const retryAfter = error.code === 'RATE_LIMITED' ? { 'retry-after': String(seconds) } : undefined;
    return problem(status, error.code, requestId, { ...error.details }, retryAfter);
  }
  // Unexpected: log with the request id; reveal nothing (SECURITY §5 — no personal data in logs).
  console.error(`[${requestId}] unhandled error`, error);
  return problem(500, 'INTERNAL_ERROR', requestId);
}
