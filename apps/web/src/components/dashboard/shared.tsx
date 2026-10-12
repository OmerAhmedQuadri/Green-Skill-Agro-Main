'use client';

import type { DashboardTab } from '@gsa/core';
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { keys } from '@/lib/query-keys';
import { REFRESH_MS } from './refresh';

/** Everything the tabs are filtered by, as the address keeps it — so a view can be bookmarked or sent (ADR-0054). */
export type DashboardFilter = {
  readonly from: string; readonly to: string; readonly date: string; readonly quiet: string;
  readonly sellerId: string; readonly storeId: string; readonly vehicleId: string; readonly categoryId: string; readonly productId: string; readonly channel: string;
};
export type SetFilter = (patch: Partial<DashboardFilter & { tab: DashboardTab }>) => void;


/** The parts of the filter each tab answers to — and so shows. */
export const USES: Record<DashboardTab, readonly (keyof DashboardFilter)[]> = {
  sales: ['from', 'to', 'sellerId', 'storeId', 'vehicleId', 'categoryId', 'productId', 'channel'],
  team: ['date'],
  stores: ['from', 'to', 'sellerId', 'quiet'],
  money: ['from', 'to', 'sellerId', 'storeId'],
  stock: ['categoryId', 'productId'],
};

/** The query a tab sends: what it uses, as given. */
export const tabQuery = (tab: DashboardTab, filter: DashboardFilter): string => new URLSearchParams(
  USES[tab].map((k): [string, string] => [k === 'quiet' ? 'quietDays' : k, filter[k]]).filter(([, v]) => v),
).toString();

/** When the open tab's figures were read, and a way to read them again now. */
export function Freshness({ query }: { query: UseQueryResult<unknown> }) {
  const t = useTranslations('dashboard');
  const format = useFormat();
  if (!query.dataUpdatedAt) return null;
  return (
    <div className="flex items-center justify-end gap-2 text-xs text-stone-500" data-testid="dashboard-freshness">
      <span>{t('updated', { time: format.time(new Date(query.dataUpdatedAt)) })}</span>
      <button type="button" onClick={() => { void query.refetch(); }} disabled={query.isFetching} aria-label={t('refresh')}
        className="rounded p-1 text-brand-800 hover:bg-stone-100 disabled:opacity-50" data-testid="dashboard-refresh">
        <RefreshCw className={query.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />
      </button>
    </div>
  );
}

/** A tab's figures: read on opening, every two minutes after, the last ones kept on screen while the next arrive. */
export function useTabQuery<T>(tab: DashboardTab, query: string) {
  return useQuery({
    queryKey: keys.dashboard(tab, query), queryFn: () => api<T>(`/dashboard/${tab}?${query}`),
    refetchInterval: REFRESH_MS, placeholderData: keepPreviousData,
  });
}
