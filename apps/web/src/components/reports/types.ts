export const TREND_DIMENSIONS = ['PRODUCT', 'SKU', 'SELLER', 'STORE', 'CATEGORY'] as const;
export type TrendDimension = (typeof TREND_DIMENSIONS)[number];

export type Movement = {
  period: string;
  packs: number;
  revenue: string;
  against: string | null;
  revenueChange: string | null;
  packsChange: string | null;
};

export type Trends = {
  dimension: TrendDimension;
  compare: 'PREVIOUS' | 'YEAR_AGO';
  months: string[];
  rows: { key: string; label: { nameEn: string; nameAr: string }; movements: Movement[] }[];
  /** RPT-011: under a year of trading, a guide rather than a projection. */
  guide: boolean;
};

export type Recommendation = {
  skuId: string;
  code: string;
  product: { nameEn: string; nameAr: string };
  variety: { nameEn: string; nameAr: string } | null;
  onHand: number;
  inTransit: number;
  perDay: string;
  basisUsed: 'TRAILING' | 'SEASONAL';
  guide: boolean;
  leadTimeDays: number;
  safetyCoverDays: number;
  projectedAtArrival: number;
  safetyLevel: number;
  suggested: number;
};

export type Reorder = { builtAt: string | null; items: Recommendation[] };
