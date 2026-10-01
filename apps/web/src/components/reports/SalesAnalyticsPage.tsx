'use client';

import { businessDate, sumMoney, type Money } from '@gsa/core';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Alert, Button, Card, cn, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import type { SaleSummary } from '@/components/sales/types';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { BarList, ColumnChart, type BarRow } from './charts';
import type { AnalyticsOptions, BreakdownRow, SalesAnalytics } from './types';

const DIMENSIONS = ['sellerId', 'storeId', 'vehicleId', 'categoryId', 'productId', 'channel'] as const;
type Dimension = (typeof DIMENSIONS)[number];
type Filter = { from: string; to: string } & Record<Dimension, string>;

/** Calendar arithmetic on `YYYY-MM-DD` — dates, not instants, so no time zone moves them. */
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

/** Presets before a custom range: nobody fights a calendar for "this month". */
const PRESETS = {
  thisMonth: (today: string) => ({ from: monthStart(today), to: today }),
  lastMonth: (today: string) => { const end = shift(monthStart(today), -1); return { from: monthStart(end), to: end }; },
  last30: (today: string) => ({ from: shift(today, -29), to: today }),
  last90: (today: string) => ({ from: shift(today, -89), to: today }),
  thisYear: (today: string) => ({ from: `${today.slice(0, 4)}-01-01`, to: today }),
} as const;
type Preset = keyof typeof PRESETS;

function readFilter(params: URLSearchParams, today: string): Filter {
  const fallback = PRESETS.thisMonth(today);
  return {
    from: params.get('from') ?? fallback.from, to: params.get('to') ?? fallback.to,
    sellerId: params.get('sellerId') ?? '', storeId: params.get('storeId') ?? '', vehicleId: params.get('vehicleId') ?? '',
    categoryId: params.get('categoryId') ?? '', productId: params.get('productId') ?? '', channel: params.get('channel') ?? '',
  };
}

const queryOf = (filter: Filter) => new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();

/**
 * ADR-0048: every sale of a period, net of what came back — totals, the run
 * day by day or month by month, and by seller, store, product and category —
 * with the sales themselves underneath for whoever may see them. The filters
 * live in the address, so a view can be bookmarked and sent; everything on the
 * page answers to the same filters, so the figures always agree.
 */
export function SalesAnalyticsPage({ canListSales }: { canListSales: boolean }) {
  const t = useTranslations('analytics');
  const format = useFormat();
  const errorText = useErrorText();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const today = businessDate(new Date());
  const filter = readFilter(new URLSearchParams(params.toString()), today);
  const query = queryOf(filter);

  const set = (patch: Partial<Filter>) => {
    const next = { ...filter, ...patch };
    // A product belongs to one category: choosing another category lets the product go.
    if (patch.categoryId !== undefined && patch.categoryId !== filter.categoryId) next.productId = '';
    router.replace(`${pathname}?${queryOf(next)}`, { scroll: false });
  };

  const options = useQuery({ queryKey: keys.analyticsOptions, queryFn: () => api<AnalyticsOptions>('/reports/sales-analytics/options') });
  // Refetching keeps the last figures on screen, dimmed — no flash, no jump.
  const view = useQuery({
    queryKey: keys.salesAnalytics({ query }), queryFn: () => api<SalesAnalytics>(`/reports/sales-analytics?${query}`), placeholderData: keepPreviousData,
  });

  const o = options.data;
  const products = (o?.products ?? []).filter((p) => !filter.categoryId || p.categoryId === filter.categoryId);
  const activePreset = (Object.keys(PRESETS) as Preset[]).find((k) => {
    const r = PRESETS[k](today);
    return r.from === filter.from && r.to === filter.to;
  });
  const narrowed = DIMENSIONS.some((d) => filter[d]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <Card className="space-y-4 p-4" data-testid="analytics-filters">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(PRESETS) as Preset[]).map((k) => (
            <Button key={k} size="sm" variant={activePreset === k ? 'primary' : 'secondary'} onClick={() => set(PRESETS[k](today))} data-testid={`preset-${k}`}>
              {t(`presets.${k}`)}
            </Button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="an-from" label={t('filters.from')}>
            <Input id="an-from" type="date" dir="ltr" value={filter.from} max={filter.to} onChange={(e) => { if (e.target.value) set({ from: e.target.value }); }} />
          </Field>
          <Field id="an-to" label={t('filters.to')}>
            <Input id="an-to" type="date" dir="ltr" value={filter.to} min={filter.from} onChange={(e) => { if (e.target.value) set({ to: e.target.value }); }} />
          </Field>
          <Choice id="an-seller" label={t('filters.seller')} value={filter.sellerId} onChange={(v) => set({ sellerId: v })} all={t('filters.all')}
            options={(o?.sellers ?? []).map((s) => ({ value: s.id, label: s.name }))} />
          <Choice id="an-store" label={t('filters.store')} value={filter.storeId} onChange={(v) => set({ storeId: v })} all={t('filters.all')}
            options={(o?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))} />
          <Choice id="an-vehicle" label={t('filters.vehicle')} value={filter.vehicleId} onChange={(v) => set({ vehicleId: v })} all={t('filters.all')}
            options={(o?.vehicles ?? []).map((v) => ({ value: v.id, label: v.registration }))} />
          <Choice id="an-category" label={t('filters.category')} value={filter.categoryId} onChange={(v) => set({ categoryId: v })} all={t('filters.all')}
            options={(o?.categories ?? []).map((c) => ({ value: c.id, label: format.name(c) }))} />
          <Choice id="an-product" label={t('filters.product')} value={filter.productId} onChange={(v) => set({ productId: v })} all={t('filters.all')}
            options={products.map((p) => ({ value: p.id, label: format.name(p) }))} />
          <Choice id="an-channel" label={t('filters.channel')} value={filter.channel} onChange={(v) => set({ channel: v })} all={t('filters.all')}
            options={(['VEHICLE', 'DISPATCH'] as const).map((c) => ({ value: c, label: t(`channels.${c}`) }))} />
        </div>
        {narrowed ? (
          <Button size="sm" variant="ghost" onClick={() => set({ sellerId: '', storeId: '', vehicleId: '', categoryId: '', productId: '', channel: '' })}>{t('filters.clear')}</Button>
        ) : null}
      </Card>

      {view.error ? <Alert>{errorText(view.error)}</Alert> : null}
      {view.data ? (
        <div className={cn('space-y-6 transition-opacity', view.isPlaceholderData && 'opacity-60')} data-testid="analytics-view">
          <Figures data={view.data} />
          {/* A one-day view is one column: the tiles say it all, so there is no chart to draw. */}
          {view.data.series.length > 1 ? (
            <Section title={t(view.data.range.bucket === 'DAY' ? 'overTimeByDay' : 'overTimeByMonth')} description={t('netHint')}>
              <div className="p-5">
                <OverTime data={view.data} />
              </div>
            </Section>
          ) : null}
          <div className="grid gap-6 lg:grid-cols-2">
            <Breakdown title={t('bySeller')} rows={view.data.bySeller} name={(r) => r.label.nameEn} onPick={(id) => set({ sellerId: id })} testId="by-seller" />
            <Breakdown title={t('byStore')} rows={view.data.byStore} name={(r) => r.label.nameEn} onPick={(id) => set({ storeId: id })} testId="by-store" />
            <Breakdown title={t('byProduct')} rows={view.data.byProduct} name={(r) => format.name(r.label)} onPick={(id) => set({ productId: id })} testId="by-product" />
            <Breakdown title={t('byCategory')} rows={view.data.byCategory} name={(r) => format.name(r.label)} onPick={(id) => set({ categoryId: id })} testId="by-category" />
          </div>
          {canListSales ? <SalesList query={query} /> : null}
        </div>
      ) : view.isPending ? <p className="text-sm text-stone-500">{t('loading')}</p> : null}
    </div>
  );
}

function Choice({ id, label, value, onChange, options, all }: {
  id: string; label: string; value: string; onChange: (value: string) => void; all: string;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <Field id={id} label={label}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </Field>
  );
}

function Tile({ label, value, hint, testId, lead = false }: { label: string; value: string; hint?: ReactNode; testId: string; lead?: boolean }) {
  return (
    <Card className="p-4">
      <div className="text-sm text-stone-600">{label}</div>
      <div className={cn('mt-1 font-semibold text-stone-900', lead ? 'text-3xl' : 'text-xl')} data-testid={testId}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-stone-500">{hint}</div> : null}
    </Card>
  );
}

/** The headline numbers, the net figure leading: what the period comes to after returns. */
function Figures({ data }: { data: SalesAnalytics }) {
  const t = useTranslations('analytics');
  const format = useFormat();
  const totals = data.totals;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile lead label={t('tiles.net')} value={format.money(totals.net)} hint={t('salesCount', { count: totals.sales })} testId="tile-net" />
      <Tile label={t('tiles.sold')} value={format.money(totals.sold)} hint={totals.average ? t('tiles.average', { amount: format.money(totals.average) }) : undefined} testId="tile-sold" />
      <Tile label={t('tiles.returned')} value={format.money(totals.returned)} hint={t('tiles.packs', { count: totals.packs })} testId="tile-returned" />
      <Tile label={t('tiles.channels')} value={format.money(data.channels.VEHICLE)} testId="tile-vehicle"
        hint={t('tiles.fromWarehouse', { amount: format.money(data.channels.DISPATCH) })} />
    </div>
  );
}

/** Net sales over the range as columns, with the same figures as a table for anyone who would rather read them. */
function OverTime({ data }: { data: SalesAnalytics }) {
  const t = useTranslations('analytics');
  const format = useFormat();
  const daily = data.range.bucket === 'DAY';
  const name = (period: string) => (daily ? format.date(period) : format.month(period));
  // A label under every seventh day or so; every month fits.
  const every = daily ? Math.max(1, Math.ceil(data.series.length / 7)) : 1;
  return (
    <div className="space-y-4">
      <ColumnChart
        testId="over-time" axis={(v) => format.compact(v)}
        columns={data.series.map((p, i) => ({
          key: p.period, value: p.net,
          label: i % every === 0 ? (daily ? format.shortDay(p.period) : format.shortMonth(p.period)) : '',
          description: t('columnDescription', { period: name(p.period), amount: format.money(p.net) }),
          tooltip: (
            <>
              <div className="font-semibold text-stone-900">{format.money(p.net)}</div>
              <div className="text-xs text-stone-600">{name(p.period)}</div>
              <div className="text-xs text-stone-500">{t('soldAndReturned', { sold: format.money(p.sold), returned: format.money(p.returned) })}</div>
            </>
          ),
        }))}
      />
      <details>
        <summary className="cursor-pointer text-sm text-brand-800">{t('asTable')}</summary>
        <div className="mt-3">
          <Table head={[t('period'), t('tiles.sold'), t('tiles.returned'), t('tiles.net'), t('sales')]}>
            {data.series.map((p) => (
              <tr key={p.period}>
                <Cell>{name(p.period)}</Cell><Cell>{format.money(p.sold)}</Cell><Cell>{format.money(p.returned)}</Cell>
                <Cell>{format.money(p.net)}</Cell><Cell>{format.number(p.sales)}</Cell>
              </tr>
            ))}
          </Table>
        </div>
      </details>
    </div>
  );
}

const TOP = 8;

/** The biggest eight by net sales, and the rest as one row — a bar for each, its figure beside it. */
function Breakdown({ title, rows, name, onPick, testId }: {
  title: string; rows: readonly BreakdownRow[]; name: (row: BreakdownRow) => string; onPick: (id: string) => void; testId: string;
}) {
  const t = useTranslations('analytics');
  const format = useFormat();
  const rest = rows.slice(TOP);
  const bars: BarRow[] = rows.slice(0, TOP).map((r) => ({ key: r.id, label: name(r), value: r.net, display: format.money(r.net) }));
  if (rest.length > 0) {
    const total: Money = sumMoney(rest.map((r) => r.net));
    bars.push({ key: 'others', label: t('others', { count: rest.length }), value: total, display: format.money(total) });
  }
  return (
    <Section title={title}>
      <div className="p-5">
        {bars.length === 0 ? <p className="text-sm text-stone-500">{t('nothing')}</p>
          : <BarList rows={bars} testId={testId} onPick={(key) => { if (key !== 'others') onPick(key); }} />}
      </div>
    </Section>
  );
}

type Page = { items: SaleSummary[]; nextCursor: string | null };

/** The sales behind the figures, newest first — for whoever may see every sale (`sales.view_all`). */
function SalesList({ query }: { query: string }) {
  const t = useTranslations('analytics');
  const format = useFormat();
  const list = useInfiniteQuery({
    queryKey: keys.sales({ analytics: query }),
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams(query);
      qs.set('status', 'COMPLETED');
      qs.set('limit', '50');
      if (pageParam) qs.set('cursor', pageParam);
      return api<Page>(`/sales?${qs.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Section title={t('salesTitle')}>
      {items.length === 0 && !list.isPending ? <p className="p-5 text-sm text-stone-500">{t('nothing')}</p> : (
        <Table head={[t('completed'), t('document'), t('filters.store'), t('filters.seller'), t('filters.vehicle'), t('total')]}>
          {items.map((s) => (
            <tr key={s.id} data-testid={`sale-${s.id}`}>
              <Cell className="whitespace-nowrap">{s.completedAt ? format.dateTime(s.completedAt) : '—'}</Cell>
              <Cell className="whitespace-nowrap">
                <Link href={`/console/sales/${s.id}`} className="font-medium underline"><bdi dir="ltr">{s.documentNumber ?? s.id.slice(0, 8)}</bdi></Link>
              </Cell>
              <Cell>{s.store.name}</Cell>
              <Cell>{s.seller.name}</Cell>
              <Cell className="whitespace-nowrap">{s.vehicle ? <bdi dir="ltr">{s.vehicle.registration}</bdi> : t(`channels.${s.channel}`)}</Cell>
              <Cell className="whitespace-nowrap">{format.money(s.total)}</Cell>
            </tr>
          ))}
        </Table>
      )}
      {list.hasNextPage ? (
        <div className="border-t border-stone-200 p-4">
          <Button variant="secondary" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>{t('more')}</Button>
        </div>
      ) : null}
    </Section>
  );
}
