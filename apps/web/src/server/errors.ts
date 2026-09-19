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
  INVALID_REGISTRATION: 422,
  DUPLICATE_REGISTRATION: 422,
  VEHICLE_INACTIVE: 409,
  VEHICLE_NOT_ASSIGNED: 409,
  SELLER_HAS_VEHICLE: 409,
  VEHICLE_HAS_STOCK: 409,
  HANDOVER_PENDING: 409,
  // VEH-006: a warning, not a refusal — the client asks, then resends acknowledged.
  CEILING_WARNING: 409,
  EMPTY_LOAD: 422,
  CHECK_IN_REQUIRED: 409,
  ZONE_AUTHORISATION_PENDING: 409,
  ON_BREAK: 409,
  ALREADY_CHECKED_IN: 409,
  NOT_CHECKED_IN: 409,
  LOCATION_REQUIRED: 422,
  ODOMETER_REQUIRED: 422,
  INVALID_ODOMETER: 422,
  NO_VEHICLE_TODAY: 409,
  ALREADY_DECLARED: 409,
  // STO-008: a warning — the client shows the likely duplicates and resends acknowledged.
  DUPLICATE_STORE_WARNING: 409,
  CREDIT_MODE_UNAVAILABLE: 422,
  PAYMENT_EXCEEDS_BALANCE: 422,
  STORE_NOT_ACTIVE: 409,
  EMPTY_SALE: 422,
  DUPLICATE_LINE: 422,
  NO_PRICE: 422,
  DISCOUNT_NOT_PERMITTED: 403,
  DISCOUNT_ABOVE_CEILING: 409,
  DISCOUNT_ABOVE_MAXIMUM: 422,
  DISCOUNT_RAISED: 422,
  CREDIT_BLOCKED: 409,
  CREDIT_LIMIT_EXCEEDED: 409,
  PAYMENT_REQUIRED: 422,
  DOCUMENT_NOT_READY: 409,
  DOCUMENT_SENDING_DISABLED: 409,
  RECEIPT_MISMATCH: 422,
  NOTHING_RECEIVED: 422,
  CLAIM_PENDING: 409,
  STORE_HAS_NO_SELLER: 409,
  EMPTY_RETURN: 422,
  SALE_NOT_COMPLETED: 409,
  RETURN_CONDITION_DISABLED: 409,
  RETURN_WINDOW_CLOSED: 409,
  SALE_ALREADY_PAID: 409,
  RETURN_EXCEEDS_UNPAID: 409,
  RETURN_EXCEEDS_HELD: 409,
  REPLACEMENT_ONLY_DEFECTIVE: 422,
  REPLACEMENT_NEEDS_VEHICLE: 409,
  REFUND_NEEDS_SELLER: 409,
  REFUND_EXCEEDS_CASH_IN_HAND: 409,
  SETTLEMENT_ABOVE_CASH_IN_HAND: 409,
  RECEIVER_REQUIRED: 422,
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
