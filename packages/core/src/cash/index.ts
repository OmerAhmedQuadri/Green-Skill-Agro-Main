/**
 * The cash ledger (DATA-MODEL §3.3, ADR-0037). Signed: + raises the seller's
 * cash in hand. M6 posts COLLECTION, M8 a cash REFUND on a credit note
 * (ADR-0039); settlements arrive in M9.
 */
export const CASH_LEDGER_ENTRY_TYPES = ['COLLECTION', 'SETTLEMENT_APPROVED', 'DISCREPANCY', 'REFUND'] as const;
export type CashLedgerEntryType = (typeof CASH_LEDGER_ENTRY_TYPES)[number];
