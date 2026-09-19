import type { dispatch } from '@gsa/services';

export type DispatchOrder = dispatch.DispatchOrder;
export type DispatchSummary = dispatch.DispatchSummary;
export type DispatchOptions = dispatch.DispatchOptions;
export type RaiseResult = dispatch.RaiseResult;
export type Page<T> = { items: T[]; nextCursor: string | null };

export const DISPATCH_TONE = { REQUESTED: 'warning', BEING_HANDLED: 'warning', RELEASED: 'neutral', DELIVERED: 'warning', CLOSED: 'success' } as const;
