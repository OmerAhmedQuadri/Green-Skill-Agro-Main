import type { cash, stores } from '@gsa/services';

export type Settlement = cash.Settlement;
export type Exposure = cash.Exposure;
export type Flag = cash.Flag;
export type AwaitingTransfer = stores.AwaitingTransfer;

export const SETTLEMENT_TONE = { SUBMITTED: 'warning', APPROVED: 'success', REJECTED: 'neutral' } as const;
