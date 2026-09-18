'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDeferredValue, useState } from 'react';
import { Alert, Button, Card, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { PoStatusBadge } from './StatusBadge';
import type { PoStatus, PoSummary } from './types';

type Page = { items: PoSummary[]; nextCursor: string | null };
const FILTERS = ['OPEN', 'DRAFT', 'PENDING_APPROVAL', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'CLOSED', 'ALL'] as const;

/** PO-001: purchase orders, newest first, filtered by where they are in their life. */
export function PurchaseOrdersPage({ canCreate }: { canCreate: boolean }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('OPEN');
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search);
  const list = useInfiniteQuery({
    queryKey: keys.purchaseOrders({ filter, query }),
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (filter === 'OPEN') qs.set('open', 'true');
      else if (filter !== 'ALL') qs.set('status', filter satisfies PoStatus);
      if (query) qs.set('search', query);
      if (pageParam) qs.set('cursor', pageParam);
      return api<Page>(`/purchase-orders?${qs.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('procurement.title')} subtitle={t('procurement.subtitle')}
        actions={canCreate ? <Link href="/console/purchase-orders/new"><Button><Plus className="size-4" aria-hidden />{t('procurement.newOrder')}</Button></Link> : undefined} />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-stone-200 p-4">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('procurement.searchPlaceholder')} aria-label={t('common.search')} className="ps-9" />
          </div>
          <Select value={filter} onChange={(e) => setFilter(FILTERS.find((f) => f === e.target.value) ?? 'OPEN')} aria-label={t('common.status')} className="w-auto">
            {FILTERS.map((f) => <option key={f} value={f}>{t(`procurement.filters.${f}`)}</option>)}
          </Select>
        </div>
        {list.error ? <div className="p-4"><Alert>{errorText(list.error)}</Alert></div> : null}
        {list.isPending ? <p className="p-5 text-sm text-stone-500">{t('common.loading')}</p> : null}
        {!list.isPending && !list.error && rows.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('procurement.empty')}</p> : null}
        {rows.length > 0 ? (
          <Table head={[t('procurement.number'), t('procurement.vendor'), t('procurement.expectedArrival'), t('procurement.value'), t('common.status')]}>
            {rows.map((po) => (
              <tr key={po.id} className="hover:bg-stone-50">
                <Cell><Link href={`/console/purchase-orders/${po.id}`} className="font-mono font-medium text-brand-800 hover:underline"><bdi dir="ltr">{po.number}</bdi></Link></Cell>
                <Cell><bdi dir="ltr" className="font-mono">{po.vendor.code}</bdi><div className="text-xs text-stone-500">{po.vendor.name}</div></Cell>
                <Cell>{po.expectedArrival ? format.date(po.expectedArrival) : '—'}</Cell>
                <Cell>{format.money(po.orderValue)}</Cell>
                <Cell><PoStatusBadge po={po} /></Cell>
              </tr>
            ))}
          </Table>
        ) : null}
        {list.hasNextPage ? (
          <div className="border-t border-stone-200 p-3 text-center">
            <Button variant="ghost" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>{t('common.loadMore')}</Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
