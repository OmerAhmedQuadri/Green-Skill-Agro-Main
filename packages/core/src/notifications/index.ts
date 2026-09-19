/**
 * In-app notifications (ADR-0034). A row carries a kind and parameters; the
 * client renders the words in the reader's language.
 */
export const NOTIFICATION_KINDS = [
  'LOAD_ISSUED', 'LOAD_DISPUTED', 'LOAD_CONFIRMED', 'LOAD_CANCELLED',
  'HANDOVER_PROPOSED', 'HANDOVER_COMPLETED',
  'CHECK_IN_AWAITING_AUTHORISATION', 'CHECK_IN_AUTHORISED', 'DAY_OPENED_ON_BEHALF',
  'CLOSING_VARIANCE', 'VEHICLE_RETURN_RECORDED',
  'STORE_PENDING_APPROVAL', 'STORE_APPROVED', 'STORE_REJECTED', 'STORE_ASSIGNED', 'CREDIT_OVERRIDE_GRANTED',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** How often the client asks (ARCHITECTURE §6.6). No websockets in Phase 1. */
export const NOTIFICATION_POLL_MS = 30_000;
