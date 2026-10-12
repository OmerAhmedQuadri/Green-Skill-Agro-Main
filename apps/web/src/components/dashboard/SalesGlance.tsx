'use client';

import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { Tile } from '@/components/common/Tile';
import { BarList, ColumnChart } from '@/components/reports/charts';
import { partyName } from '@/components/sales/party';
import { useFormat } from '@/lib/format';
import type { DashboardSales } from './types';

/**
 * RPT-012 (ADR-0054): today and this month so far — against the same days of
 * last month — the last thirty days, who and what sold most this month, and
 * the latest sales. Net of returns throughout, as the analytics are.
 */
export function SalesGlance({ data }: { data: DashboardSales }) {
  const t = useTranslations('dashboard.sales');
  const ts = useTranslations('sales');
  const format = useFormat();
  const up = data.change !== null && !data.change.startsWith('-');
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <Section
      id="sales-glance" title={t('title')} description={t('hint')}
      actions={<Link href="/console/reports/sales" className="text-sm font-medium text-brand-800 hover:underline">{t('open')}</Link>}
    >
      <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
        <Tile lead label={t('today')} value={format.money(data.today.net)} hint={t('salesCount', { count: data.today.sales })} testId="glance-today" />
        <Tile
          label={t('month')} value={format.money(data.month.net)} testId="glance-month"
          hint={data.change === null ? t('noComparison') : (
            <span className={up ? 'text-brand-800' : 'text-red-700'} data-testid="glance-change">
              <Arrow className="me-0.5 inline size-3.5 rtl:-scale-x-100" aria-hidden />
              {t(up ? 'up' : 'down', { percent: format.percent(data.change.replace('-', '')), amount: format.money(data.lastMonth.net) })}
            </span>
          )}
        />
        <Tile label={t('returned')} value={format.money(data.month.returned)} hint={t('salesCount', { count: data.month.sales })} testId="glance-returned" />
        <Tile label={t('average')} value={data.month.average ? format.money(data.month.average) : '—'} hint={t('averageHint')} testId="glance-average" />
      </div>

      <div className="grid gap-6 border-t border-stone-200 p-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-3">
          <h3 className="text-sm font-semibold text-stone-900">{t('chart')}</h3>
          <ColumnChart
            testId="glance-chart" height={200} axis={(v) => format.compact(v)}
            columns={data.series.map((p, i) => ({
              key: p.period, value: p.net,
              // A date under every fifth day, and today's.
              label: i % 5 === 0 || i === data.series.length - 1 ? format.shortDay(p.period) : '',
              description: t('columnDescription', { day: format.date(p.period), amount: format.money(p.net) }),
              tooltip: (
                <>
                  <div className="font-semibold text-stone-900">{format.money(p.net)}</div>
                  <div className="text-xs text-stone-600">{format.date(p.period)}</div>
                  <div className="text-xs text-stone-500">{t('salesCount', { count: p.sales })}</div>
                </>
              ),
            }))}
          />
        </div>
        <div className="min-w-0 space-y-5">
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-stone-900">{t('topSellers')}</h3>
            {data.topSellers.length === 0 ? <p className="text-sm text-stone-500">{t('nothingYet')}</p> : (
              <BarList testId="top-sellers" rows={data.topSellers.map((r) => ({ key: r.id, label: format.name(r.label), value: r.net, display: format.money(r.net) }))} />
            )}
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-stone-900">{t('topProducts')}</h3>
            {data.topProducts.length === 0 ? <p className="text-sm text-stone-500">{t('nothingYet')}</p> : (
              <BarList testId="top-products" rows={data.topProducts.map((r) => ({ key: r.id, label: format.name(r.label), value: r.net, display: format.money(r.net) }))} />
            )}
          </div>
        </div>
      </div>

      {data.recent ? (
        <div className="border-t border-stone-200" data-testid="recent-sales">
          <h3 className="px-5 pt-4 pb-2 text-sm font-semibold text-stone-900">{t('recent')}</h3>
          {data.recent.length === 0 ? <p className="px-5 pb-5 text-sm text-stone-500">{t('noRecent')}</p> : (
            <Table head={[t('when'), t('to'), t('by'), t('total')]}>
              {data.recent.map((s) => (
                <tr key={s.id} data-testid={`recent-${s.id}`}>
                  <Cell className="whitespace-nowrap text-stone-600">{format.dateTime(s.completedAt ?? s.createdAt)}</Cell>
                  <Cell>
                    <Link href={`/console/sales/${s.id}`} className="font-medium text-brand-800 hover:underline">{partyName(s.store, s.buyerName, ts)}</Link>
                    {s.documentNumber ? <bdi dir="ltr" className="block text-xs text-stone-500">{s.documentNumber}</bdi> : null}
                  </Cell>
                  <Cell>{s.seller.name}</Cell>
                  <Cell className="whitespace-nowrap font-medium">{format.money(s.total)}</Cell>
                </tr>
              ))}
            </Table>
          )}
        </div>
      ) : null}
    </Section>
  );
}
