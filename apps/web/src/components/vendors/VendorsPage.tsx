'use client';

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDeferredValue, useState } from 'react';
import { Alert, Button, Card, Input } from '@gsa/ui';
import { ActiveBadge } from '@/components/common/ActiveBadge';
import { PageHeader } from '@/components/common/PageHeader';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { Vendor } from './types';
import { VendorForm, type VendorInput } from './VendorForm';

type Page = { items: Vendor[]; nextCursor: string | null };

/** Workflow B: the vendor register. Created by Admin and Super Admin (OQ-013). */
export function VendorsPage({ canManage }: { canManage: boolean }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const query = useDeferredValue(search);
  const list = useInfiniteQuery({
    queryKey: keys.vendors({ query }),
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (query) qs.set('search', query);
      if (pageParam) qs.set('cursor', pageParam);
      return api<Page>(`/vendors?${qs.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const create = useCommand((body: VendorInput, key) => api<Vendor>('/vendors', { method: 'POST', body, idempotencyKey: key }), {
    onSuccess: () => {
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: keys.vendors() });
      void queryClient.invalidateQueries({ queryKey: keys.vendorCodes });
    },
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('vendors.title')} subtitle={t('vendors.subtitle')}
        actions={canManage && !creating ? <Button onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />{t('vendors.newVendor')}</Button> : undefined} />

      {creating ? (
        <Section title={t('vendors.newVendor')}>
          <div className="p-5">
            <VendorForm submitLabel={t('vendors.create')} pending={create.isPending} error={create.error} onSubmit={create.run} onCancel={() => setCreating(false)} />
          </div>
        </Section>
      ) : null}

      <Card>
        <div className="border-b border-stone-200 p-4">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('vendors.searchPlaceholder')} aria-label={t('common.search')} className="ps-9" />
          </div>
        </div>
        {list.error ? <div className="p-4"><Alert>{errorText(list.error)}</Alert></div> : null}
        {list.isPending ? <p className="p-5 text-sm text-stone-500">{t('common.loading')}</p> : null}
        {!list.isPending && !list.error && rows.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('vendors.empty')}</p> : null}
        {rows.length > 0 ? (
          <Table head={[t('vendors.code'), t('vendors.name'), t('vendors.country'), t('vendors.contactPerson'), t('common.status')]}>
            {rows.map((v) => (
              <tr key={v.id} className="hover:bg-stone-50">
                <Cell><Link href={`/console/vendors/${v.id}`} className="font-mono font-medium text-brand-800 hover:underline"><bdi dir="ltr">{v.code}</bdi></Link></Cell>
                <Cell>{v.name}</Cell>
                <Cell>{format.country(v.country)}</Cell>
                <Cell>{v.contactPerson ?? '—'}</Cell>
                <Cell><ActiveBadge active={v.isActive} /></Cell>
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
