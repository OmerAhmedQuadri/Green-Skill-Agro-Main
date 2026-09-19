'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Input } from '@gsa/ui';
import type { PriceList } from '@/components/catalogue/types';
import { ActiveBadge } from '@/components/common/ActiveBadge';
import { NameFields } from '@/components/common/NameFields';
import { PageHeader } from '@/components/common/PageHeader';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { decimalText, formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { PriceListRow } from './types';

type Data = { list: PriceList; rows: PriceListRow[] };

/** PRC-001..003: every SKU's price on one list, edited together. A blank price takes the SKU off the list. */
export function PriceListView({ id }: { id: string }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const data = useQuery({ queryKey: keys.priceList(id), queryFn: () => api<Data>(`/price-lists/${id}`) });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [saved, setSaved] = useState(false);

  const replace = (next: Data) => {
    queryClient.setQueryData(keys.priceList(id), next);
    void queryClient.invalidateQueries({ queryKey: keys.priceLists });
    void queryClient.invalidateQueries({ queryKey: ['product'] });
  };
  const save = useCommand((body: { items: { skuId: string; price: string | null }[] }, key) =>
    api<Data>(`/price-lists/${id}/items`, { method: 'PUT', body, idempotencyKey: key }), { onSuccess: (next) => { replace(next); setDraft({}); setSaved(true); } });
  const update = useCommand((body: { version: number; nameEn?: string; nameAr?: string; isActive?: boolean }, key) =>
    api<PriceList>(`/price-lists/${id}`, { method: 'PATCH', body, idempotencyKey: key }), { onSuccess: () => { setRenaming(false); void data.refetch(); void queryClient.invalidateQueries({ queryKey: keys.priceLists }); } });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = data.data?.rows ?? [];
    return q ? all.filter((r) => [r.code, r.productEn, r.productAr, r.varietyEn ?? '', r.varietyAr ?? ''].some((v) => v.toLowerCase().includes(q))) : all;
  }, [data.data, search]);

  if (data.error) return <Alert>{errorText(data.error)}</Alert>;
  if (!data.data) return <p className="text-sm text-stone-500">{t('common.loading')}</p>;
  const { list } = data.data;
  const original = new Map<string, string>(data.data.rows.map((r) => [r.skuId, r.price ?? '']));
  const changes = Object.entries(draft).map(([skuId, value]) => [skuId, decimalText(value)] as const)
    .filter(([skuId, value]) => value !== (original.get(skuId) ?? ''))
    .map(([skuId, value]) => ({ skuId, price: value === '' ? null : value }));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        back={{ href: '/console/pricing', label: t('pricing.title') }}
        title={<span className="flex flex-wrap items-center gap-3">{format.name(list)}{list.isBase ? <Badge tone="success">{t('pricing.base')}</Badge> : null}<ActiveBadge active={list.isActive} /></span>}
        subtitle={list.isBase ? t('pricing.baseHint') : t('pricing.additionalHint')}
        actions={(
          <>
            <Button variant="ghost" onClick={() => setRenaming(true)}>{t('pricing.rename')}</Button>
            {!list.isBase ? (
              <Button variant="secondary" disabled={update.isPending} onClick={() => update.run({ version: list.version, isActive: !list.isActive })}>
                {list.isActive ? t('common.deactivate') : t('common.reactivate')}
              </Button>
            ) : null}
          </>
        )}
      />
      {update.error ? <Alert>{errorText(update.error)}</Alert> : null}
      {renaming ? (
        <Section title={t('pricing.rename')}>
          <form className="grid gap-4 p-5 sm:grid-cols-2" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            update.run({ version: list.version, nameEn: formText(f, 'nameEn'), nameAr: formText(f, 'nameAr') });
          }}>
            <NameFields prefix="list" defaults={list} />
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" disabled={update.isPending}>{t('common.save')}</Button>
              <Button variant="ghost" onClick={() => setRenaming(false)}>{t('common.cancel')}</Button>
            </div>
          </form>
        </Section>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 p-4">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('pricing.searchSkus')} aria-label={t('common.search')} className="ps-9" />
          </div>
          <div className="flex items-center gap-3">
            {changes.length > 0 ? <span className="text-sm text-stone-600">{t('pricing.unsaved', { count: changes.length })}</span> : null}
            <Button disabled={changes.length === 0 || save.isPending || !list.isActive} onClick={() => { setSaved(false); save.run({ items: changes }); }}>
              {save.isPending ? t('common.saving') : t('pricing.savePrices')}
            </Button>
          </div>
        </div>
        {save.error ? <div className="p-4"><Alert>{errorText(save.error)}</Alert></div> : null}
        {saved && changes.length === 0 ? <div className="p-4"><Alert tone="success">{t('common.saved')}</Alert></div> : null}
        {rows.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('pricing.noSkus')}</p> : (
          <Table head={[t('catalogue.skuCode'), t('catalogue.product'), t('catalogue.packSize'), t('catalogue.packaging'), t('pricing.pricePerPack')]}>
            {rows.map((r) => (
              <tr key={r.skuId} className={r.isActive ? '' : 'opacity-60'}>
                <Cell><bdi dir="ltr" className="font-mono">{r.code}</bdi></Cell>
                <Cell>
                  {format.name({ nameEn: r.productEn, nameAr: r.productAr })}
                  {r.varietyEn !== null && r.varietyAr !== null ? <div className="text-xs text-stone-500">{format.name({ nameEn: r.varietyEn, nameAr: r.varietyAr })}</div> : null}
                </Cell>
                <Cell>{format.size(r.size, r.countUnit)}</Cell>
                <Cell>{t(`catalogue.packagingValues.${r.packaging}`)}</Cell>
                <Cell>
                  <Input aria-label={t('pricing.priceFor', { code: r.code })} inputMode="decimal" dir="ltr" className="w-32"
                    value={draft[r.skuId] ?? r.price ?? ''} disabled={!list.isActive}
                    onChange={(e) => setDraft((d) => ({ ...d, [r.skuId]: e.target.value }))} />
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
