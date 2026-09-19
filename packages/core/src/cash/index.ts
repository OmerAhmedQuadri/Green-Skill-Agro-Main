/**
 * The cash ledger (DATA-MODEL §3.3, ADR-0037). Signed: + raises the seller's
 * cash in hand. M6 posts COLLECTION; settlements arrive in M9.
 */
export const CASH_LEDGER_ENTRY_TYPES = ['COLLECTION', 'SETTLEMENT_APPROVED', 'DISCREPANCY'] as const;
export type CashLedgerEntryType = (typeof CASH_LEDGER_ENTRY_TYPES)[number];
