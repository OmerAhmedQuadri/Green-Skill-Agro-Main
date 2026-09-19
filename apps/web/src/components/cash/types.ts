import type { cash } from '@gsa/services';

export type Settlement = cash.Settlement;
export type Exposure = cash.Exposure;
export type Flag = cash.Flag;

export const SETTLEMENT_TONE = { SUBMITTED: 'warning', APPROVED: 'success', REJECTED: 'neutral' } as const;
