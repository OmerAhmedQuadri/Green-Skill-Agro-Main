import type { inventory, procurement } from '@gsa/services';

export type PoSummary = procurement.PoSummary;
export type PoDetail = procurement.PoDetail;
export type PoLine = procurement.PoLine;
export type IncomingLine = procurement.IncomingLine;
export type PreviewRow = procurement.PreviewRow;
export type ReceiveLine = procurement.ReceiveLine;
export type SkuStock = inventory.SkuStock;
export type BatchStock = inventory.BatchStock;
export type LotMatch = inventory.LotMatch;
export type PoStatus = PoSummary['status'];
export type PoAction = 'submit' | 'reject' | 'approve' | 'place' | 'confirm' | 'despatch' | 'close_short' | 'cancel';

export type ProcurementCan = { manage: boolean; approve: boolean; receive: boolean; import: boolean };

/** Which actions each state offers, and whether they need a reason (STATE-MACHINES §1). The service decides; this only offers. */
export const ACTIONS: Record<PoStatus, { action: PoAction; needs: 'manage' | 'approve'; reason?: true; tone?: 'danger' }[]> = {
  DRAFT: [{ action: 'submit', needs: 'manage' }, { action: 'cancel', needs: 'manage', reason: true, tone: 'danger' }],
  PENDING_APPROVAL: [{ action: 'approve', needs: 'approve' }, { action: 'reject', needs: 'approve', reason: true }, { action: 'cancel', needs: 'manage', reason: true, tone: 'danger' }],
  APPROVED: [{ action: 'place', needs: 'approve' }, { action: 'cancel', needs: 'approve', reason: true, tone: 'danger' }],
  PLACED: [{ action: 'confirm', needs: 'manage' }, { action: 'despatch', needs: 'manage' }, { action: 'cancel', needs: 'approve', reason: true, tone: 'danger' }],
  CONFIRMED: [{ action: 'despatch', needs: 'manage' }, { action: 'cancel', needs: 'approve', reason: true, tone: 'danger' }],
  IN_TRANSIT: [{ action: 'cancel', needs: 'approve', reason: true, tone: 'danger' }],
  PARTIALLY_RECEIVED: [{ action: 'close_short', needs: 'approve', reason: true }],
  FULLY_RECEIVED: [],
  CLOSED: [],
};

export const RECEIVABLE: readonly PoStatus[] = ['PLACED', 'CONFIRMED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'];
