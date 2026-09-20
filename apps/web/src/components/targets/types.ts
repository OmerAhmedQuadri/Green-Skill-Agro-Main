export const TARGET_METRICS = ['REVENUE', 'PACKS_SOLD', 'NEW_STORES', 'COLLECTED'] as const;
export type TargetMetric = (typeof TARGET_METRICS)[number];

export type TargetGoals = { [M in TargetMetric]?: string | undefined };

export type MetricProgress = {
  metric: TargetMetric;
  goal: string;
  actual: string;
  /** May exceed 100 — a seller can reach 140% of a goal. */
  achievement: string;
  met: boolean;
};

export type TargetStanding = {
  seller: { id: string; name: string };
  period: string;
  goals: TargetGoals | null;
  progress: { metrics: MetricProgress[]; met: boolean };
  behindPace: boolean;
  base: string;
  rate: string | null;
  commission: string | null;
  /** COM-008: the month has frozen and these figures are the snapshot. */
  final: boolean;
};

export type SellerTarget = {
  id: string;
  seller: { id: string; name: string };
  period: string;
  goals: TargetGoals;
  note: string | null;
  version: number;
};

/** Money metrics are shown as money; the other two are counts. */
export const isMoneyMetric = (metric: TargetMetric): boolean => metric === 'REVENUE' || metric === 'COLLECTED';
