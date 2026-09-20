'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Alert, Badge, Card } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { TargetProgressBars } from './TargetProgressBars';
import type { TargetStanding } from './types';

/**
 * TGT-004, COM-007: the seller's own month — where they stand against each
 * figure, and what they have earned on cash that reached the business. Never
 * anybody else's figures.
 */
export function MyTargets() {
  const t = useTranslations('targets');
  const format = useFormat();
  const errorText = useErrorText();
  const standing = useQuery({ queryKey: keys.myStanding(), queryFn: () => api<TargetStanding>('/targets/me') });

  if (standing.isPending) return <p className="p-4 text-sm text-stone-500">{t('loading')}</p>;
  if (standing.error) return <div className="p-4"><Alert>{errorText(standing.error)}</Alert></div>;
  const s = standing.data;

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title={t('myTitle')}
        subtitle={<bdi dir="ltr">{s.period}</bdi>}
        actions={s.final
          ? <Badge tone="neutral" data-testid="period-state">{t('final')}</Badge>
          : <Badge tone="warning" data-testid="period-state">{t('live')}</Badge>}
      />

      {/* TGT-006: said plainly, while there are still days left to do something about it. */}
      {s.behindPace ? <Alert tone="warning" data-testid="behind-pace">{t('behindPace')}</Alert> : null}

      <Card className="space-y-4 p-4">
        <TargetProgressBars metrics={s.progress.metrics} testIdPrefix="my-metric" />
        {s.goals && s.progress.metrics.length > 0 ? (
          <p className="text-sm" data-testid="my-met">
            {s.progress.met ? t('metAll') : t('notMetAll')}
          </p>
        ) : null}
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-sm font-semibold text-stone-900">{t('commissionTitle')}</h2>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-stone-600">{t('base')}</dt>
            <dd data-testid="commission-base">{format.money(s.base)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-stone-600">{t('rate')}</dt>
            <dd>{s.rate === null ? t('noRate') : <bdi dir="ltr">{format.percent(s.rate)}</bdi>}</dd>
          </div>
          <div className="flex justify-between gap-2 border-t border-stone-100 pt-1 font-medium">
            <dt>{t('commission')}</dt>
            <dd data-testid="commission-amount">{s.commission === null ? t('noRate') : format.money(s.commission)}</dd>
          </div>
        </dl>
        {/* COM-001: the one sentence that explains every figure above. */}
        <p className="text-xs text-stone-500">{t('baseHint')}</p>
      </Card>
    </div>
  );
}
