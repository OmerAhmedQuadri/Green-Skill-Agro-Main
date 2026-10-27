'use client';

import { IMPORTED_UNMATCHED_KEY, OPEN_SALES_KEY } from '@gsa/core';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Alert, cn } from '@gsa/ui';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { Tile } from '@/components/common/Tile';
import { BarList, ColumnChart } from '@/components/reports/charts';
import { ImportedNote } from '@/components/reports/imported';
import { partyName } from '@/components/sales/party';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { Freshness, tabQuery, useTabQuery, type DashboardFilter, type SetFilter } from './shared';
import type { SalesTabData } from './types';

/**
 * RPT-012 (ADR-0054): a period's sales under every filter of the analytics —
 * against the same days of last month, or as many days before — the run over
 * the period, who, where and what sold most (pick one to narrow to it), and
 * the latest sales.
 */
export function SalesTab({ filter, set }: { filter: DashboardFilter; set: SetFilter }) {
  const t = useTranslations('dashboard.sales');
  const ta = useTranslations('analytics');
  const ts = useTranslations('sales');
  const format = useFormat();
  const errorText = useErrorText();
  const query = tabQuery('sales', filter);
  const view = useTabQuery<SalesTabData>('sales', query);
  const d = view.data;
  if (view.error) return <Alert>{errorText(view.error)}</Alert>;
  if (!d) return <p className="text-sm text-stone-500">{ta('loading')}</p>;

  const up = d.change !== null && !d.change.startsWith('-');
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  const daily = d.range.bucket === 'DAY';
  const name = (period: string) => (daily ? format.date(period) : format.month(period));
  const every = daily ? Math.max(1, Math.ceil(d.series.length / 8)) : 1;
  const bars = (rows: SalesTabData['bySeller'], label: (r: SalesTabData['bySeller'][number]) => string) =>
    rows.slice(0, 8).map((r) => ({ key: r.id, label: label(r), value: r.net, display: format.money(r.net) }));
  const comparedWith = t('against', { from: format.date(d.previous.from), to: format.date(d.previous.to), amount: format.money(d.previous.totals.net) });

  return (
    <div className={cn('space-y-6 transition-opacity', view.isPlaceholderData && 'opacity-60')} data-testid="tab-sales">
      <Freshness query={view} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile lead label={ta('tiles.net')} value={format.money(d.totals.net)} testId="sales-net"
          hint={d.change === null ? <span>{t('noComparison')}<span className="block">{comparedWith}</span></span> : (
            <span className={up ? 'text-brand-800' : 'text-red-700'} data-testid="sales-change">
              <Arrow className="me-0.5 inline size-3.5 rtl:-scale-x-100" aria-hidden />
              {t(up ? 'up' : 'down', { percent: format.percent(d.change.replace('-', '')) })}
              <span className="block text-stone-500">{comparedWith}</span>
            </span>
          )} />
        <Tile label={ta('tiles.sold')} value={format.money(d.totals.sold)} testId="sales-sold"
          hint={d.totals.average ? ta('tiles.average', { amount: format.money(d.totals.average) }) : ta('salesCount', { count: d.totals.sales })} />
        <Tile label={ta('tiles.returned')} value={format.money(d.totals.returned)} testId="sales-returned" hint={ta('salesCount', { count: d.totals.sales })} />
        <Tile label={ta('tiles.channels')} value={format.money(d.channels.VEHICLE)} testId="sales-vehicle"
          hint={ta('tiles.fromWarehouse', { amount: format.money(d.channels.DISPATCH) })} />
      </div>
      <ImportedNote amount={d.channels.IMPORTED} channel={filter.channel} onHide={() => set({ channel: 'APP' })} testId="sales-imported" />

      {d.series.length > 1 ? (
        <Section title={ta(daily ? 'overTimeByDay' : 'overTimeByMonth')} description={ta('netHint')}>
          <div className="p-5">
            <ColumnChart
              testId="sales-chart" height={200} axis={(v) => format.compact(v)}
              columns={d.series.map((p, i) => ({
                key: p.period, value: p.net,
                label: i % every === 0 ? (daily ? format.shortDay(p.period) : format.shortMonth(p.period)) : '',
                description: ta('columnDescription', { period: name(p.period), amount: format.money(p.net) }),
                tooltip: (
                  <>
                    <div className="font-semibold text-stone-900">{format.money(p.net)}</div>
                    <div className="text-xs text-stone-600">{name(p.period)}</div>
                    <div className="text-xs text-stone-500">{ta('salesCount', { count: p.sales })}</div>
                  </>
                ),
              }))}
            />
          </div>
        </Section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {[
          { key: 'sellers', title: ta('bySeller'), rows: bars(d.bySeller, (r) => r.label.nameEn), pick: (id: string) => set({ sellerId: id }) },
          // SAL-019: open sales are one line of their own — not a store to narrow to.
          { key: 'stores', title: ta('byStore'), rows: bars(d.byStore, (r) => (r.id === OPEN_SALES_KEY ? ta('openSales') : r.label.nameEn)), pick: (id: string) => { if (id !== OPEN_SALES_KEY) set({ storeId: id }); } },
          // IMP-007: imported lines naming no catalogue product are one row of their own — not a product to narrow to.
          { key: 'products', title: ta('byProduct'), rows: bars(d.byProduct, (r) => (r.id === IMPORTED_UNMATCHED_KEY ? ta('imported.notInCatalogue') : format.name(r.label))), pick: (id: string) => { if (id !== IMPORTED_UNMATCHED_KEY) set({ productId: id }); } },
          { key: 'categories', title: ta('byCategory'), rows: bars(d.byCategory, (r) => (r.id === IMPORTED_UNMATCHED_KEY ? ta('imported.notInCatalogue') : format.name(r.label))), pick: (id: string) => { if (id !== IMPORTED_UNMATCHED_KEY) set({ categoryId: id }); } },
        ].map((b) => (
          <Section key={b.key} title={b.title}>
            <div className="p-5">
              {b.rows.length === 0 ? <p className="text-sm text-stone-500">{ta('nothing')}</p> : <BarList testId={`sales-top-${b.key}`} rows={b.rows} onPick={b.pick} />}
            </div>
          </Section>
        ))}
      </div>

      {d.latest ? (
        <Section title={t('recent')}
          actions={<Link href={`/console/reports/sales?${query}`} className="text-sm font-medium text-brand-800 hover:underline">{t('open')}</Link>}>
          <div data-testid="sales-latest">
            {d.latest.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('noRecent')}</p> : (
              <Table head={[t('when'), t('to'), t('by'), t('total')]}>
                {d.latest.map((s) => (
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
        </Section>
      ) : null}
    </div>
  );
}
