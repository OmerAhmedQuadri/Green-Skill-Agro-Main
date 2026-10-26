'use client';

import { businessDate, QUIET_DAYS, type DashboardTab } from '@gsa/core';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Card, Field, Input, Select } from '@gsa/ui';
import { Tabs } from '@/components/common/Tabs';
import { Choice, PRESETS, PresetButtons } from '@/components/reports/filters';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { keys } from '@/lib/query-keys';
import { MoneyTab } from './MoneyTab';
import { SalesTab } from './SalesTab';
import { StockTab } from './StockTab';
import { StoresTab } from './StoresTab';
import { TeamTab } from './TeamTab';
import { USES, type DashboardFilter, type SetFilter } from './shared';
import type { DashboardOptions } from './types';

/**
 * RPT-012..016 (ADR-0054): the dashboard's tabs — sales, the team, stores,
 * money and stock — each for whoever may see some of it, with the filters
 * that tab answers to. The tab and its filters live in the address; the open
 * tab reads its figures again every two minutes.
 */
export function Dashboard({ tabs }: { tabs: readonly DashboardTab[] }) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const today = businessDate(new Date());
  const month = PRESETS.thisMonth(today);
  const filter: DashboardFilter = {
    from: params.get('from') ?? month.from, to: params.get('to') ?? month.to, date: params.get('date') ?? today, quiet: params.get('quiet') ?? '30',
    sellerId: params.get('sellerId') ?? '', storeId: params.get('storeId') ?? '', vehicleId: params.get('vehicleId') ?? '',
    categoryId: params.get('categoryId') ?? '', productId: params.get('productId') ?? '', channel: params.get('channel') ?? '',
  };
  const active = tabs.find((x) => x === params.get('tab')) ?? tabs[0];

  const set: SetFilter = (patch) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v); else next.delete(k);
    }
    // A product belongs to one category: choosing another category lets the product go.
    if (patch.categoryId !== undefined && patch.categoryId !== filter.categoryId) next.delete('productId');
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  if (!active) return null;
  return (
    <Tabs id="dashboard" label={t('tabsLabel')} tabs={tabs.map((key) => ({ key, label: t(`tabs.${key}`) }))} active={active} onChange={(tab) => set({ tab })}>
      <div className="space-y-6">
        <Filters tab={active} filter={filter} set={set} today={today} />
        {active === 'sales' ? <SalesTab filter={filter} set={set} /> : null}
        {active === 'team' ? <TeamTab filter={filter} /> : null}
        {active === 'stores' ? <StoresTab filter={filter} /> : null}
        {active === 'money' ? <MoneyTab filter={filter} /> : null}
        {active === 'stock' ? <StockTab filter={filter} /> : null}
      </div>
    </Tabs>
  );
}

/** The filters the open tab answers to. */
function Filters({ tab, filter, set, today }: { tab: DashboardTab; filter: DashboardFilter; set: SetFilter; today: string }) {
  const t = useTranslations('dashboard.filters');
  const ta = useTranslations('analytics');
  const format = useFormat();
  const options = useQuery({ queryKey: keys.dashboardOptions, queryFn: () => api<DashboardOptions>('/dashboard/options') });
  const o = options.data;
  const uses = (k: keyof DashboardFilter) => USES[tab].includes(k);
  const products = (o?.products ?? []).filter((p) => !filter.categoryId || p.categoryId === filter.categoryId);
  const narrowed = USES[tab].some((k) => !['from', 'to', 'date', 'quiet'].includes(k) && filter[k]);
  return (
    <Card className="space-y-4 p-4" data-testid="dashboard-filters">
      {uses('from') ? <PresetButtons range={filter} today={today} onPick={(range) => set(range)} testIdPrefix="dash-preset" /> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {uses('from') ? (
          <>
            <Field id="dash-from" label={ta('filters.from')}>
              <Input id="dash-from" type="date" dir="ltr" value={filter.from} max={filter.to} onChange={(e) => { if (e.target.value) set({ from: e.target.value }); }} />
            </Field>
            <Field id="dash-to" label={ta('filters.to')}>
              <Input id="dash-to" type="date" dir="ltr" value={filter.to} min={filter.from} max={today} onChange={(e) => { if (e.target.value) set({ to: e.target.value }); }} />
            </Field>
          </>
        ) : null}
        {uses('date') ? (
          <Field id="dash-date" label={t('day')}>
            <div className="flex gap-2">
              <Input id="dash-date" type="date" dir="ltr" value={filter.date} max={today} onChange={(e) => { if (e.target.value) set({ date: e.target.value === today ? '' : e.target.value }); }} />
              {filter.date !== today ? <Button size="sm" variant="secondary" onClick={() => set({ date: '' })} data-testid="dash-today">{t('today')}</Button> : null}
            </div>
          </Field>
        ) : null}
        {uses('sellerId') ? (
          <Choice id="dash-seller" label={ta('filters.seller')} value={filter.sellerId} onChange={(v) => set({ sellerId: v })} all={ta('filters.all')}
            options={(o?.sellers ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        ) : null}
        {uses('storeId') ? (
          <Choice id="dash-store" label={ta('filters.store')} value={filter.storeId} onChange={(v) => set({ storeId: v })} all={ta('filters.all')}
            options={(o?.stores ?? []).map((s) => ({ value: s.id, label: `${s.name} · ${s.code}` }))} />
        ) : null}
        {uses('vehicleId') ? (
          <Choice id="dash-vehicle" label={ta('filters.vehicle')} value={filter.vehicleId} onChange={(v) => set({ vehicleId: v })} all={ta('filters.all')}
            options={(o?.vehicles ?? []).map((v) => ({ value: v.id, label: v.registration }))} />
        ) : null}
        {uses('categoryId') ? (
          <Choice id="dash-category" label={ta('filters.category')} value={filter.categoryId} onChange={(v) => set({ categoryId: v })} all={ta('filters.all')}
            options={(o?.categories ?? []).map((c) => ({ value: c.id, label: format.name(c) }))} />
        ) : null}
        {uses('productId') ? (
          <Choice id="dash-product" label={ta('filters.product')} value={filter.productId} onChange={(v) => set({ productId: v })} all={ta('filters.all')}
            options={products.map((p) => ({ value: p.id, label: format.name(p) }))} />
        ) : null}
        {uses('channel') ? (
          <Choice id="dash-channel" label={ta('filters.channel')} value={filter.channel} onChange={(v) => set({ channel: v })} all={ta('filters.all')}
            options={(['VEHICLE', 'DISPATCH', 'APP', 'IMPORTED'] as const).map((c) => ({ value: c, label: ta(`channels.${c}`) }))} />
        ) : null}
        {uses('quiet') ? (
          <Field id="dash-quiet" label={t('quiet')}>
            <Select id="dash-quiet" value={filter.quiet} onChange={(e) => set({ quiet: e.target.value === '30' ? '' : e.target.value })}>
              {QUIET_DAYS.map((d) => <option key={d} value={String(d)}>{t('quietDays', { days: d })}</option>)}
            </Select>
          </Field>
        ) : null}
      </div>
      {narrowed ? (
        <Button size="sm" variant="ghost" onClick={() => set({ sellerId: '', storeId: '', vehicleId: '', categoryId: '', productId: '', channel: '' })}>{ta('filters.clear')}</Button>
      ) : null}
    </Card>
  );
}
