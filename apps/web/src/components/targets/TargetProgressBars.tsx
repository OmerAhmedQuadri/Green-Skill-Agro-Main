'use client';

import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/format';
import { isMoneyMetric, type MetricProgress } from './types';

/**
 * TGT-004, COM-004: one bar per figure the manager set, showing where the
 * seller stands against it. A figure that was not set has no bar — a seller is
 * never shown a goal nobody gave them (OQ-023).
 */
export function TargetProgressBars({ metrics, testIdPrefix = 'metric' }: { metrics: readonly MetricProgress[]; testIdPrefix?: string }) {
  const t = useTranslations('targets');
  const format = useFormat();
  const show = (metric: MetricProgress['metric'], value: string) =>
    isMoneyMetric(metric) ? format.money(value) : format.number(Number(value));

  if (metrics.length === 0) return <p className="text-sm text-stone-500">{t('noTarget')}</p>;
  return (
    <ul className="space-y-3">
      {metrics.map((m) => (
        <li key={m.metric} data-testid={`${testIdPrefix}-${m.metric}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="font-medium">{t(`metrics.${m.metric}`)}</span>
            <span className="text-stone-600">
              {show(m.metric, m.actual)}
              {' / '}
              {show(m.metric, m.goal)}
              {' · '}
              <bdi dir="ltr" data-testid={`achievement-${m.metric}`}>{format.percent(m.achievement)}</bdi>
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-stone-200">
            <div
              className={`h-full rounded-full ${m.met ? 'bg-emerald-600' : 'bg-amber-500'}`}
              // The bar stops at full; the percentage beside it carries anything above.
              style={{ inlineSize: `${Math.min(100, Number(m.achievement))}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
