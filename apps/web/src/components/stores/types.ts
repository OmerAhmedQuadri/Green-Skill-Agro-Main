import type { stores } from '@gsa/services';

export type Store = stores.Store;
export type StoreSummary = stores.StoreSummary;
export type LedgerEntry = stores.LedgerEntry;
/** IMP-005: what an imported store's books come to, not in its account yet. */
export type ImportedHistory = stores.ImportedHistory;
/** IMP-010: a statement of the store's account, printed by the worker. */
export type StoreStatement = stores.StoreStatement;
export type StoreOptions = Awaited<ReturnType<typeof stores.storeOptions>>;
export type Payment = stores.Payment;
export type CreditStatus = Store['credit'];
export type DuplicateMatch = { storeId: string; name: string; distanceM: number; similarityPercent: number; reasons: ('NEARBY' | 'SIMILAR_NAME')[] };
export const CREDIT_MODES = ['BILL_TO_BILL', 'WEEKLY', 'MONTHLY', 'CUSTOM'] as const;
export const STATUS_TONE = { PENDING_APPROVAL: 'warning', ACTIVE: 'success', REJECTED: 'danger', INACTIVE: 'neutral', AWAITING_REVERIFICATION: 'warning' } as const;
