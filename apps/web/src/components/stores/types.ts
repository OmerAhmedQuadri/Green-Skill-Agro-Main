import type { stores } from '@gsa/services';

export type Store = stores.Store;
export type StoreSummary = stores.StoreSummary;
export type LedgerEntry = stores.LedgerEntry;
export type StoreOptions = Awaited<ReturnType<typeof stores.storeOptions>>;
export type Payment = stores.Payment;
export type CreditStatus = Store['credit'];
export type DuplicateMatch = { storeId: string; name: string; distanceM: number; similarityPercent: number; reasons: ('NEARBY' | 'SIMILAR_NAME')[] };
export const CREDIT_MODES = ['BILL_TO_BILL', 'WEEKLY', 'MONTHLY', 'CUSTOM'] as const;
export const STATUS_TONE = { PENDING_APPROVAL: 'warning', ACTIVE: 'success', REJECTED: 'danger', INACTIVE: 'neutral' } as const;
