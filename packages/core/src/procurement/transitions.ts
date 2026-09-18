import { DomainError } from '../errors';
import type { PermissionCode } from '../identity';

/** PO-001: nine states, CLOSED terminal (STATE-MACHINES §1). */
export const PO_STATUSES = [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PLACED', 'CONFIRMED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED',
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

/** PO-007: a closed order says how it closed. */
export const PO_CLOSE_REASONS = ['COMPLETE', 'SHORT', 'CANCELLED'] as const;
export type PoCloseReason = (typeof PO_CLOSE_REASONS)[number];

export type PoAction =
  | 'submit' | 'reject' | 'approve' | 'place' | 'confirm' | 'despatch' | 'close_short' | 'close_complete' | 'cancel';

type Rule = { readonly from: readonly PoStatus[]; readonly to: PoStatus; readonly permission: PermissionCode; readonly reason?: 'REQUIRED' };

const BEFORE_APPROVAL: readonly PoStatus[] = ['DRAFT', 'PENDING_APPROVAL'];
const AFTER_APPROVAL: readonly PoStatus[] = ['APPROVED', 'PLACED', 'CONFIRMED', 'IN_TRANSIT'];

const RULES: Record<Exclude<PoAction, 'cancel'>, Rule> = {
  submit: { from: ['DRAFT'], to: 'PENDING_APPROVAL', permission: 'procurement.manage_po' },
  reject: { from: ['PENDING_APPROVAL'], to: 'DRAFT', permission: 'procurement.approve_po', reason: 'REQUIRED' },
  approve: { from: ['PENDING_APPROVAL'], to: 'APPROVED', permission: 'procurement.approve_po' },
  place: { from: ['APPROVED'], to: 'PLACED', permission: 'procurement.approve_po' },
  confirm: { from: ['PLACED'], to: 'CONFIRMED', permission: 'procurement.manage_po' },
  despatch: { from: ['PLACED', 'CONFIRMED'], to: 'IN_TRANSIT', permission: 'procurement.manage_po' },
  close_short: { from: ['PARTIALLY_RECEIVED'], to: 'CLOSED', permission: 'procurement.approve_po', reason: 'REQUIRED' },
  close_complete: { from: ['FULLY_RECEIVED'], to: 'CLOSED', permission: 'procurement.approve_po' },
};

export type PoTransition = { readonly to: PoStatus; readonly closeReason: PoCloseReason | null };

/**
 * The only way a purchase order changes state (STATE-MACHINES §1). Checks the
 * source state, the permission and the reason; the caller persists the result.
 * Cancelling needs manage_po before approval and approve_po after, and is
 * refused once anything is received — that order is closed short instead.
 */
export function transitionPo(
  status: PoStatus, action: PoAction, permissions: ReadonlySet<PermissionCode>, reason: string | null,
): PoTransition {
  if (action === 'cancel') {
    const allowed = BEFORE_APPROVAL.includes(status) ? 'procurement.manage_po' : 'procurement.approve_po';
    if (!BEFORE_APPROVAL.includes(status) && !AFTER_APPROVAL.includes(status)) throw new DomainError('INVALID_TRANSITION', { status, action });
    if (!permissions.has(allowed)) throw new DomainError('FORBIDDEN', { permission: allowed });
    if (!reason?.trim()) throw new DomainError('REASON_REQUIRED', { action });
    return { to: 'CLOSED', closeReason: 'CANCELLED' };
  }
  const rule = RULES[action];
  if (!rule.from.includes(status)) throw new DomainError('INVALID_TRANSITION', { status, action });
  if (!permissions.has(rule.permission)) throw new DomainError('FORBIDDEN', { permission: rule.permission });
  if (rule.reason === 'REQUIRED' && !reason?.trim()) throw new DomainError('REASON_REQUIRED', { action });
  const closeReason: PoCloseReason | null = action === 'close_short' ? 'SHORT' : action === 'close_complete' ? 'COMPLETE' : null;
  return { to: rule.to, closeReason };
}

/** Receipt is allowed from PLACED on: goods sometimes arrive before anyone records the despatch. */
export const RECEIVABLE: readonly PoStatus[] = ['PLACED', 'CONFIRMED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'];

/** A PO is edited only in DRAFT (STATE-MACHINES §1). */
export const isEditable = (status: PoStatus): boolean => status === 'DRAFT';

/**
 * After a receipt: fully received when every line has at least its ordered
 * packs, otherwise partially. Over-receipt is recorded, not refused (RCV-007).
 */
export function statusAfterReceipt(lines: readonly { ordered: number; received: number }[]): PoStatus {
  return lines.every((l) => l.received >= l.ordered) ? 'FULLY_RECEIVED' : 'PARTIALLY_RECEIVED';
}

/** PO-004/006, STK-007: packs still expected — only while the order is live and not closed. */
export function outstandingPacks(status: PoStatus, ordered: number, received: number): number {
  if (status === 'CLOSED' || status === 'DRAFT' || status === 'PENDING_APPROVAL' || status === 'APPROVED') return 0;
  return Math.max(ordered - received, 0);
}

/** A human-readable number, e.g. PO-2026-0007. */
export const poNumber = (year: number, sequence: number): string => `PO-${year}-${String(sequence).padStart(4, '0')}`;
