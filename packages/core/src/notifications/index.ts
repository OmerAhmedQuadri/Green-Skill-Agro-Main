import type { PermissionCode } from '../identity';

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
  'DISCOUNT_APPROVAL_REQUESTED', 'DISCOUNT_APPROVED', 'DISCOUNT_REDUCED', 'DISCOUNT_REJECTED', 'DISCOUNT_EXPIRED',
  'DISPATCH_REQUESTED', 'DISPATCH_CREATED_FOR_YOU', 'DISPATCH_RELEASED', 'DISPATCH_CANCELLED', 'LOST_CLAIM_RAISED', 'LOST_CLAIM_DECIDED',
  'SETTLEMENT_SUBMITTED', 'SETTLEMENT_APPROVED', 'SETTLEMENT_REJECTED', 'CEILING_BREACHED',
  'TRANSFER_RECORDED', 'TRANSFER_NOT_RECEIVED',
  'TARGET_SET', 'TARGET_BEHIND_PACE', 'TARGET_MISSED', 'PERIOD_CLOSED',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** How often the client asks (ARCHITECTURE §6.6). No websockets in Phase 1. */
export const NOTIFICATION_POLL_MS = 30_000;

export const REQUEST_OUTCOMES = [
  'APPROVED', 'REDUCED', 'REJECTED', 'CONFIRMED', 'NOT_RECEIVED', 'REVIEWED', 'AUTHORISED',
  'TAKEN', 'RELEASED', 'CANCELLED', 'EXPIRED', 'WITHDRAWN',
] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];

/**
 * ADR-0051: the kinds that are requests, and how each can end. A request goes
 * to everyone who can act on it; when it ends, every copy says how, when and
 * by whom, and stops counting as unread.
 */
export const REQUEST_ENDS = {
  STORE_PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
  DISCOUNT_APPROVAL_REQUESTED: ['APPROVED', 'REDUCED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'],
  SETTLEMENT_SUBMITTED: ['APPROVED', 'REJECTED'],
  TRANSFER_RECORDED: ['CONFIRMED', 'NOT_RECEIVED'],
  CLOSING_VARIANCE: ['REVIEWED'],
  CHECK_IN_AWAITING_AUTHORISATION: ['AUTHORISED', 'WITHDRAWN'],
  LOST_CLAIM_RAISED: ['APPROVED', 'REJECTED'],
  DISPATCH_REQUESTED: ['TAKEN', 'RELEASED', 'CANCELLED'],
} as const satisfies Partial<Record<NotificationKind, readonly RequestOutcome[]>>;
export type RequestKind = keyof typeof REQUEST_ENDS;
export type RequestOutcomes = { readonly [K in RequestKind]: (typeof REQUEST_ENDS)[K][number] };
export const REQUEST_KINDS = Object.keys(REQUEST_ENDS) as RequestKind[];

/**
 * DSP-005: a dispatch request taken is handled but not finished — another
 * manager may take it over, or it may be handed back. Any later outcome
 * replaces this one; every other outcome is final.
 */
export const PROVISIONAL_OUTCOMES = ['TAKEN'] as const satisfies readonly RequestOutcome[];

export const isRequestKind = (kind: NotificationKind): kind is RequestKind => (REQUEST_KINDS as readonly NotificationKind[]).includes(kind);

/**
 * ADR-0051: what can wait for a decision on the dashboard, and the permission
 * that decides it — most urgent first: a seller waiting in a shop, a seller
 * waiting to start the day. Write-offs and purchase orders send no
 * notification, so this is where they surface.
 */
export const DECISION_QUEUES = {
  DISCOUNTS: 'sales.approve_discount',
  CHECK_INS: 'attendance.manage',
  DISPATCH: 'sales.fulfil_dispatch',
  STORES: 'stores.approve',
  SETTLEMENTS: 'cash.approve_settlement',
  TRANSFERS: 'cash.approve_settlement',
  LOST_CLAIMS: 'sales.approve_lost_order',
  WRITE_OFFS: 'inventory.approve_write_off',
  PURCHASE_ORDERS: 'procurement.approve_po',
  CLOSING_VARIANCES: 'inventory.audit_vehicle',
} as const satisfies Record<string, PermissionCode>;
export type DecisionQueue = keyof typeof DECISION_QUEUES;

/** The queues a reader can decide, in the dashboard's order. */
export const decisionQueuesFor = (permissions: ReadonlySet<PermissionCode>): DecisionQueue[] =>
  (Object.keys(DECISION_QUEUES) as DecisionQueue[]).filter((q) => permissions.has(DECISION_QUEUES[q]));
