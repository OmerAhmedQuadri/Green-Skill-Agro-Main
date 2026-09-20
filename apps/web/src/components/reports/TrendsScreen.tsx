'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Card, Field, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { TREND_DIMENSIONS, type TrendDimension, type Trends } from './types';

/**
 * RPT-001, RPT-002, RPT-011: what moved, month on month or against the same
 * month last season, by product, SKU, seller, store or category.
 */
export function TrendsScreen() {
  const t = useTranslations('reports');
  const format = useFormat();
  const errorText = useErrorText();
  const [dimension, setDimension] = useState<TrendDimension>('PRODUCT');
  const [compare, setCompare] = useState<'PREVIOUS' | 'YEAR_AGO'>('PREVIOUS');

  const trends = useQuery({
    queryKey: keys.trends({ dimension, compare }),
    queryFn: () => api<Trends>(`/reports/trends?dimension=${dimension}&compare=${compare}`),
  });

  const tone = (value: string | null) =>
    value === null ? 'text-stone-400' : Number(value) < 0 ? 'text-red-700' : 'text-emerald-700';

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('trendsTitle')} subtitle={t('trendsSubtitle')} />

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field id="dimension" label={t('by')}>
          <Select id="dimension" value={dimension} onChange={(e) => setDimension(e.target.value as TrendDimension)}>
            {TREND_DIMENSIONS.map((d) => <option key={d} value={d}>{t(`dimensions.${d}`)}</option>)}
          </Select>
        </Field>
        <Field id="compare" label={t('compare')}>
          <Select id="compare" value={compare} onChange={(e) => setCompare(e.target.value as 'PREVIOUS' | 'YEAR_AGO')}>
            <option value="PREVIOUS">{t('comparePrevious')}</option>
            <option value="YEAR_AGO">{t('compareYearAgo')}</option>
          </Select>
        </Field>
      </Card>

      {trends.error ? <Alert>{errorText(trends.error)}</Alert> : null}
      {/* RPT-011: below a year of trading, say so before the numbers rather than after. */}
      {trends.data?.guide ? <Alert tone="warning" data-testid="trends-guide">{t('guideNotice')}</Alert> : null}

      <Section title={t('trendsHead')}>
        {trends.data && trends.data.rows.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('noTrends')}</p> : null}
        {trends.data && trends.data.rows.length > 0 ? (
          <Table head={[t('name'), t('month'), t('packs'), t('revenue'), t('change')]}>
            {trends.data.rows.flatMap((row) => row.movements.map((m) => (
              <tr key={`${row.key}-${m.period}`} data-testid={`trend-${row.key}-${m.period}`}>
                <Cell className="font-medium">{format.name(row.label)}</Cell>
                <Cell><bdi dir="ltr">{m.period}</bdi></Cell>
                <Cell>{format.number(m.packs)}</Cell>
                <Cell>{format.money(m.revenue)}</Cell>
                <Cell>
                  <span className={tone(m.revenueChange)} data-testid={`change-${row.key}-${m.period}`}>
                    {m.revenueChange === null ? t('noComparison') : <bdi dir="ltr">{format.percent(m.revenueChange)}</bdi>}
                  </span>
                  {m.against ? <div className="text-xs text-stone-500"><bdi dir="ltr">{m.against}</bdi></div> : null}
                </Cell>
              </tr>
            )))}
          </Table>
        ) : null}
      </Section>
    </div>
  );
}
