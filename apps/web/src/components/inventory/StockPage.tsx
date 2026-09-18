'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDeferredValue, useState } from 'react';
import { Alert, Button, Card, Checkbox, Input } from '@gsa/ui';
import type { LotMatch, SkuStock } from '@/components/procurement/types';
import { PageHeader } from '@/components/common/PageHeader';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';

type Page = { items: SkuStock[]; nextCursor: string | null };

/**
 * STK-004..007: stock held, SKU by SKU — warehouse, vehicles, dispatched and
 * the total — in whole packs, with what is on order and in transit shown
 * apart. STK-003: LOT numbers are searchable.
 */
export function StockPage() {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const [search, setSearch] = useState('');
  const [onlyHeld, setOnlyHeld] = useState(true);
  const [lot, setLot] = useState('');
  const query = useDeferredValue(search);
  const lotQuery = useDeferredValue(lot.trim());
  const stock = useInfiniteQuery({
    queryKey: keys.stock({ query, onlyHeld }),
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '100', onlyHeld: String(onlyHeld) });
      if (query) qs.set('search', query);
      if (pageParam) qs.set('cursor', pageParam);
      return api<Page>(`/stock?${qs.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const lots = useQuery({ queryKey: keys.lots(lotQuery), enabled: lotQuery.length >= 2, queryFn: () => api<LotMatch[]>(`/batches?${new URLSearchParams({ lot: lotQuery }).toString()}`) });
  const rows = stock.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('stock.title')} subtitle={t('stock.subtitle')} />
      <Card>
        <div className="flex flex-wrap items-center gap-4 border-b border-stone-200 p-4">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('stock.searchPlaceholder')} aria-label={t('common.search')} className="ps-9" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={onlyHeld} onChange={(e) => setOnlyHeld(e.target.checked)} />{t('stock.onlyHeld')}
          </label>
        </div>
        {stock.error ? <div className="p-4"><Alert>{errorText(stock.error)}</Alert></div> : null}
        {stock.isPending ? <p className="p-5 text-sm text-stone-500">{t('common.loading')}</p> : null}
        {!stock.isPending && !stock.error && rows.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('stock.empty')}</p> : null}
        {rows.length > 0 ? (
          <Table head={[t('catalogue.skuCode'), t('catalogue.product'), t('stock.warehouse'), t('stock.vehicles'), t('stock.dispatched'), t('stock.total'), t('stock.inTransit'), t('stock.onOrder')]}>
            {rows.map((s) => (
              <tr key={s.skuId} className="hover:bg-stone-50">
                <Cell><Link href={`/console/stock/${s.skuId}`} className="font-mono text-brand-800 hover:underline"><bdi dir="ltr">{s.code}</bdi></Link></Cell>
                <Cell>
                  {format.name(s.product)}{s.variety ? ` · ${format.name(s.variety)}` : ''}
                  <div className="text-xs text-stone-500">{`${format.size(s.size, s.countUnit)} · ${t(`catalogue.packagingValues.${s.packaging}`)}`}</div>
                </Cell>
                <Cell>{format.number(s.positions.warehouse)}</Cell>
                <Cell>{format.number(s.positions.vehicles)}</Cell>
                <Cell>{format.number(s.positions.dispatched)}</Cell>
                <Cell className="font-semibold">{format.number(s.positions.total)}</Cell>
                <Cell className="text-stone-600">{format.number(s.incoming.inTransit)}</Cell>
                <Cell className="text-stone-600">{format.number(s.incoming.onOrder)}</Cell>
              </tr>
            ))}
          </Table>
        ) : null}
        {stock.hasNextPage ? (
          <div className="border-t border-stone-200 p-3 text-center">
            <Button variant="ghost" onClick={() => void stock.fetchNextPage()} disabled={stock.isFetchingNextPage}>{t('common.loadMore')}</Button>
          </div>
        ) : null}
      </Card>

      <Section title={t('stock.lotSearch')} description={t('stock.lotSearchHint')}>
        <div className="p-4">
          <Input value={lot} onChange={(e) => setLot(e.target.value)} placeholder={t('stock.lotPlaceholder')} aria-label={t('stock.lotSearch')} dir="ltr" className="max-w-sm" />
        </div>
        {lots.data && lots.data.length === 0 ? <p className="px-5 pb-5 text-sm text-stone-500">{t('stock.noLots')}</p> : null}
        {lots.data && lots.data.length > 0 ? (
          <Table head={[t('receiving.lotNumber'), t('catalogue.skuCode'), t('catalogue.product'), t('receiving.manufacturedOn'), t('receiving.expiresOn'), t('stock.total')]}>
            {lots.data.map((b) => (
              <tr key={b.batchId}>
                <Cell><bdi dir="ltr" className="font-mono">{b.lotNumber}</bdi></Cell>
                <Cell><Link href={`/console/stock/${b.skuId}`} className="font-mono text-brand-800 hover:underline"><bdi dir="ltr">{b.code}</bdi></Link></Cell>
                <Cell>{format.name(b.product)}</Cell>
                <Cell>{b.manufacturedOn ? format.date(b.manufacturedOn) : '—'}</Cell>
                <Cell>{b.expiresOn ? format.date(b.expiresOn) : '—'}</Cell>
                <Cell>{format.number(b.positions.total)}</Cell>
              </tr>
            ))}
          </Table>
        ) : null}
      </Section>
    </div>
  );
}
