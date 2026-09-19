import type { sales } from '@gsa/services';

export type Sale = sales.SaleView;
export type SaleSummary = sales.SaleSummary;
export type SaleOptions = sales.SaleOptions;
export type SaleItem = sales.SaleItem;
export type Page<T> = { items: T[]; nextCursor: string | null };

export const SALE_TONE = {
  PENDING_DISCOUNT_APPROVAL: 'warning', DISCOUNT_APPROVED: 'warning', PENDING_DELIVERY: 'warning', COMPLETED: 'success', CANCELLED: 'neutral',
} as const;
