'use client';

import { businessMonth } from '@gsa/core';
import type { reports } from '@gsa/services';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Alert, Badge, Card, Field, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';

type Performance = reports.MyPerformance;

/** Enough history to look back over, without a picker longer than a phone screen is useful. */
const MONTHS_OFFERED = 24;

/** This Riyadh month and the ones before it, newest first. */
function recentMonths(now: Date, count: number): string[] {
  const [year, month] = businessMonth(now).split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, back) => new Date(Date.UTC(year, month - 1 - back, 1)).toISOString().slice(0, 7));
}

function Row({ label, value, testId, strong = false }: { label: string; value: ReactNode; testId: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-stone-600">{label}</dt>
      <dd data-testid={testId} className={strong ? 'font-semibold text-stone-900' : undefined}>{value}</dd>
    </div>
  );
}

function Block({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="space-y-2 p-4">
      <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
      <dl className="space-y-1 text-sm">{children}</dl>
      {hint ? <p className="text-xs text-stone-500">{hint}</p> : null}
    </Card>
  );
}

/**
 * RPT-010: a seller's own figures in one place — sales, collections, cash and
 * commission, which were spread over four screens. "Right now" does not change
 * with the month; everything below it is the month chosen.
 */
export function MyPerformance() {
  const t = useTranslations('performance');
  const tCommon = useTranslations('common');
  const format = useFormat();
  const errorText = useErrorText();
  const [months] = useState(() => recentMonths(new Date(), MONTHS_OFFERED));
  const [month, setMonth] = useState(() => months[0] ?? businessMonth(new Date()));
  const figures = useQuery({
    queryKey: keys.myPerformance(month),
    queryFn: () => api<Performance>(`/reports/my-performance?${new URLSearchParams({ month }).toString()}`),
  });

  return (
    <div className="space-y-4">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <Field id="performance-month" label={t('month')}>
        <Select id="performance-month" value={month} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m, i) => <option key={m} value={m}>{i === 0 ? t('thisMonth', { month: format.month(m) }) : format.month(m)}</option>)}
        </Select>
      </Field>

      {figures.error ? <Alert>{errorText(figures.error)}</Alert> : null}
      {figures.isPending ? <p className="text-sm text-stone-500">{tCommon('loading')}</p> : null}
      {figures.data ? <Figures p={figures.data} /> : null}
    </div>
  );
}

/** The chosen month's figures. Its own component, so it is not a new type on every render of the page. */
function Figures({ p }: { p: Performance }) {
  const t = useTranslations('performance');
  const tTargets = useTranslations('targets');
  const format = useFormat();
  return (
    <>
      <Block title={t('now')} hint={t('nowHint')}>
        <Row label={t('cashInHand')} value={format.money(p.now.cashInHand)} testId="performance-cash-in-hand" strong />
        <Row label={t('awaiting')} value={format.money(p.now.awaitingApproval)} testId="performance-awaiting" />
      </Block>

      <Block title={t('sales')} hint={t('salesCount', { count: p.sales.sales })}>
        <Row label={t('sold')} value={format.money(p.sales.sold)} testId="performance-sold" />
        <Row label={t('returned')} value={format.money(p.sales.returned)} testId="performance-returned" />
        <Row label={t('net')} value={format.money(p.sales.net)} testId="performance-net" strong />
      </Block>

      <Block title={t('collected')}>
        <Row label={t('cash')} value={format.money(p.collected.cash)} testId="performance-collected-cash" />
        <Row label={t('bank')} value={format.money(p.collected.bank)} testId="performance-collected-bank" />
        <Row label={t('total')} value={format.money(p.collected.total)} testId="performance-collected-total" strong />
      </Block>

      <Block title={t('settled')} hint={t('settledHint')}>
        <Row label={t('settledApproved')} value={format.money(p.handedOver)} testId="performance-settled" strong />
      </Block>

      <Card className="space-y-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-stone-900">{tTargets('commissionTitle')}</h2>
          {p.commission.final
            ? <Badge tone="neutral" data-testid="performance-period-state">{tTargets('final')}</Badge>
            : <Badge tone="warning" data-testid="performance-period-state">{tTargets('live')}</Badge>}
        </div>
        <dl className="space-y-1 text-sm">
          <Row label={tTargets('base')} value={format.money(p.commission.base)} testId="performance-commission-base" />
          <Row label={tTargets('rate')} value={p.commission.rate === null ? tTargets('noRate') : <bdi dir="ltr">{format.percent(p.commission.rate)}</bdi>} testId="performance-rate" />
          <Row label={tTargets('commission')} value={p.commission.commission === null ? '—' : format.money(p.commission.commission)} testId="performance-commission" strong />
        </dl>
        <p className="text-xs text-stone-500">{tTargets('baseHint')}</p>
      </Card>
    </>
  );
}
