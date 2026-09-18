'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { FolderTree, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDeferredValue, useState } from 'react';
import { Alert, Button, Card, Input, Select } from '@gsa/ui';
import { ActiveBadge } from '@/components/common/ActiveBadge';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { CatalogueCan, Category, Page, ProductSummary, ProductType } from './types';

export function CataloguePage({ can }: { can: CatalogueCan }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const [search, setSearch] = useState('');
  const [typeId, setTypeId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('true');
  const query = useDeferredValue(search);

  const types = useQuery({ queryKey: keys.productTypes, queryFn: () => api<ProductType[]>('/product-types') });
  const categories = useQuery({ queryKey: keys.categories, queryFn: () => api<Category[]>('/categories') });
  const filter = { query, typeId, categoryId, status, locale: format.locale };
  const list = useInfiniteQuery({
    queryKey: keys.products(filter),
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (query) qs.set('search', query);
      if (typeId) qs.set('productTypeId', typeId);
      if (categoryId) qs.set('categoryId', categoryId);
      if (status) qs.set('isActive', status);
      if (pageParam) qs.set('cursor', pageParam);
      return api<Page<ProductSummary>>(`/products?${qs.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={t('catalogue.title')}
        subtitle={t('catalogue.subtitle')}
        actions={(
          <>
            {can.manageStructure ? (
              <Link href="/console/catalogue/structure"><Button variant="secondary"><FolderTree className="size-4" aria-hidden />{t('catalogue.structure.title')}</Button></Link>
            ) : null}
            {can.manageProducts ? (
              <Link href="/console/catalogue/new"><Button><Plus className="size-4" aria-hidden />{t('catalogue.newProduct')}</Button></Link>
            ) : null}
          </>
        )}
      />

      <Card>
        <div className="flex flex-wrap gap-3 border-b border-stone-200 p-4">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('catalogue.searchPlaceholder')} aria-label={t('common.search')} className="ps-9" />
          </div>
          <Select value={typeId} onChange={(e) => setTypeId(e.target.value)} aria-label={t('catalogue.productType')} className="w-auto">
            <option value="">{t('catalogue.allTypes')}</option>
            {types.data?.map((pt) => <option key={pt.id} value={pt.id}>{format.name(pt)}</option>)}
          </Select>
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label={t('catalogue.category')} className="w-auto">
            <option value="">{t('catalogue.allCategories')}</option>
            {categories.data?.map((c) => <option key={c.id} value={c.id}>{format.name(c)}</option>)}
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('common.status')} className="w-auto">
            <option value="true">{t('common.active')}</option>
            <option value="false">{t('common.inactive')}</option>
            <option value="">{t('common.all')}</option>
          </Select>
        </div>

        {list.error ? <div className="p-4"><Alert>{errorText(list.error)}</Alert></div> : null}
        {list.isPending ? <p className="p-5 text-sm text-stone-500">{t('common.loading')}</p> : null}
        {!list.isPending && !list.error && rows.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('catalogue.empty')}</p> : null}

        {rows.length > 0 ? (
          <Table head={[t('catalogue.product'), t('catalogue.category'), t('catalogue.productType'), t('catalogue.vendor'), t('catalogue.skus'), t('common.status')]}>
            {rows.map((p) => (
              <tr key={p.id} className="hover:bg-stone-50">
                <Cell>
                  <Link href={`/console/catalogue/${p.id}`} className="font-medium text-brand-800 hover:underline">{format.name(p)}</Link>
                  <div className="text-xs text-stone-500">{format.otherName(p)}</div>
                </Cell>
                <Cell>{format.name(p.category)}<div className="text-xs text-stone-500">{format.name(p.subCategory)}</div></Cell>
                <Cell>{format.name(p.productType)}</Cell>
                <Cell>
                  {/* VEN-005: the code links to the profile only for those with vendor access. */}
                  {p.vendor ? (can.viewVendors
                    ? <Link href={`/console/vendors/${p.vendor.id}`} className="text-brand-800 hover:underline"><bdi dir="ltr">{p.vendor.code}</bdi></Link>
                    : <bdi dir="ltr">{p.vendor.code}</bdi>) : null}
                </Cell>
                <Cell>{t('catalogue.skuCount', { count: p.skuCount })}</Cell>
                <Cell><ActiveBadge active={p.isActive} /></Cell>
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
