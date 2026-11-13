/**
 * The cash ledger (DATA-MODEL §3.3, ADR-0037). Signed: + raises the seller's
 * cash in hand. M6 posts COLLECTION, M8 a cash REFUND on a credit note
 * (ADR-0039); settlements arrive in M9. A CORRECTION goes either way: a cash payment a Super Admin corrected,
 * correcting its collector's cash in hand too (COR-005, ADR-0059).
 */
export const CASH_LEDGER_ENTRY_TYPES = ['COLLECTION', 'SETTLEMENT_APPROVED', 'DISCREPANCY', 'REFUND', 'CORRECTION'] as const;
export type CashLedgerEntryType = (typeof CASH_LEDGER_ENTRY_TYPES)[number];

export * from './settlements';
export * from './transfers';
