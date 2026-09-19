'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Field, Input, Select } from '@gsa/ui';
import type { Page, PriceList, SkuSummary } from '@/components/catalogue/types';
import { ActiveBadge } from '@/components/common/ActiveBadge';
import { NameFields } from '@/components/common/NameFields';
import { PageHeader } from '@/components/common/PageHeader';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { decimalText, formText, wholeNumber } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { DiscountCeilings } from './types';

export function PricingPage({ can }: { can: { managePriceLists: boolean; setCeilings: boolean } }) {
  const t = useTranslations();
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('pricing.title')} subtitle={t('pricing.subtitle')} />
      {can.managePriceLists ? <PriceListsSection /> : null}
      {can.setCeilings ? <CeilingsSection /> : null}
    </div>
  );
}

/** PRC-002/003: the base list, then any additional lists. */
function PriceListsSection() {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const lists = useQuery({ queryKey: keys.priceLists, queryFn: () => api<PriceList[]>('/price-lists') });
  const create = useCommand((body: { nameEn: string; nameAr: string }, key) => api<PriceList>('/price-lists', { method: 'POST', body, idempotencyKey: key }),
    { onSuccess: () => { setCreating(false); void queryClient.invalidateQueries({ queryKey: keys.priceLists }); } });

  return (
    <Section title={t('pricing.priceLists')} description={t('pricing.priceListsHint')}
      actions={!creating ? <Button variant="secondary" size="sm" onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />{t('pricing.newList')}</Button> : undefined}>
      {creating ? (
        <form className="grid gap-4 border-b border-stone-200 p-5 sm:grid-cols-2" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          create.run({ nameEn: formText(f, 'nameEn'), nameAr: formText(f, 'nameAr') });
        }}>
          {create.error ? <Alert className="sm:col-span-2">{errorText(create.error)}</Alert> : null}
          <NameFields prefix="list-new" />
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={create.isPending}>{t('pricing.createList')}</Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>{t('common.cancel')}</Button>
          </div>
        </form>
      ) : null}
      {lists.error ? <div className="p-4"><Alert>{errorText(lists.error)}</Alert></div> : null}
      {lists.data ? (
        <Table head={[t('pricing.list'), t('pricing.pricedSkus'), t('common.status')]}>
          {lists.data.map((l) => (
            <tr key={l.id} className="hover:bg-stone-50">
              <Cell>
                <Link href={`/console/pricing/${l.id}`} className="font-medium text-brand-800 hover:underline">{format.name(l)}</Link>
                {l.isBase ? <Badge tone="success" className="ms-2">{t('pricing.base')}</Badge> : null}
                <div className="text-xs text-stone-500">{format.otherName(l)}</div>
              </Cell>
              <Cell>{format.number(l.itemCount)}</Cell>
              <Cell><ActiveBadge active={l.isActive} /></Cell>
            </tr>
          ))}
        </Table>
      ) : <p className="p-5 text-sm text-stone-500">{t('common.loading')}</p>}
    </Section>
  );
}

type CeilingsInput = { orderCeiling: string; itemCeiling: string; absoluteMaximum: string; approvalExpiryMinutes: number };

/** PRC-004..007, PRC-015, PRC-016. */
function CeilingsSection() {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);
  const ceilings = useQuery({ queryKey: keys.discountCeilings, queryFn: () => api<DiscountCeilings>('/discount-ceilings') });
  const replace = (next: DiscountCeilings) => queryClient.setQueryData(keys.discountCeilings, next);
  const save = useCommand((body: CeilingsInput, key) => api<DiscountCeilings>('/discount-ceilings', { method: 'PUT', body, idempotencyKey: key }),
    { onSuccess: (next) => { replace(next); setSaved(true); } });
  const setSku = useCommand(({ skuId, ceiling }: { skuId: string; ceiling: string | null }, key) =>
    api<DiscountCeilings>(`/skus/${skuId}/discount-ceiling`, { method: 'PUT', body: { ceiling }, idempotencyKey: key }), { onSuccess: replace });

  const [skuSearch, setSkuSearch] = useState('');
  const skuQuery = useDeferredValue(skuSearch);
  const skus = useQuery({
    queryKey: keys.skus({ search: skuQuery }), enabled: skuQuery.length >= 2,
    queryFn: () => api<Page<SkuSummary>>(`/skus?${new URLSearchParams({ search: skuQuery, isActive: 'true', limit: '20' }).toString()}`),
  });
  const [skuId, setSkuId] = useState('');

  if (ceilings.error) return <Section title={t('pricing.ceilings')}><div className="p-4"><Alert>{errorText(ceilings.error)}</Alert></div></Section>;
  if (!ceilings.data) return <Section title={t('pricing.ceilings')}><p className="p-5 text-sm text-stone-500">{t('common.loading')}</p></Section>;
  const c = ceilings.data;

  return (
    <Section title={t('pricing.ceilings')} description={t('pricing.ceilingsHint')}>
      <form key={`${c.orderCeiling}-${c.itemCeiling}-${c.absoluteMaximum}-${c.approvalExpiryMinutes}`} className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4" noValidate
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          setSaved(false);
          const f = new FormData(e.currentTarget);
          save.run({
            orderCeiling: decimalText(formText(f, 'orderCeiling')), itemCeiling: decimalText(formText(f, 'itemCeiling')), absoluteMaximum: decimalText(formText(f, 'absoluteMaximum')),
            approvalExpiryMinutes: wholeNumber(formText(f, 'approvalExpiryMinutes')) ?? Number.NaN,
          });
        }}>
        {save.error ? <Alert className="sm:col-span-2 lg:col-span-4">{errorText(save.error)}</Alert> : null}
        {saved ? <Alert tone="success" className="sm:col-span-2 lg:col-span-4">{t('common.saved')}</Alert> : null}
        <PercentField id="orderCeiling" label={t('pricing.orderCeiling')} hint={t('pricing.orderCeilingHint')} value={c.orderCeiling} />
        <PercentField id="itemCeiling" label={t('pricing.itemCeiling')} hint={t('pricing.itemCeilingHint')} value={c.itemCeiling} />
        <PercentField id="absoluteMaximum" label={t('pricing.absoluteMaximum')} hint={t('pricing.absoluteMaximumHint')} value={c.absoluteMaximum} />
        <Field id="approvalExpiryMinutes" label={t('pricing.approvalExpiry')} hint={t('pricing.approvalExpiryHint')}>
          <Input id="approvalExpiryMinutes" name="approvalExpiryMinutes" type="number" min={5} max={240} dir="ltr" defaultValue={c.approvalExpiryMinutes} />
        </Field>
        <div className="sm:col-span-2 lg:col-span-4">
          <Button type="submit" disabled={save.isPending}>{save.isPending ? t('common.saving') : t('common.save')}</Button>
        </div>
      </form>

      <div className="border-t border-stone-200 p-5">
        <h3 className="text-sm font-semibold">{t('pricing.skuCeilings')}</h3>
        <p className="mt-0.5 text-sm text-stone-500">{t('pricing.skuCeilingsHint')}</p>
        {setSku.error ? <Alert className="mt-3">{errorText(setSku.error)}</Alert> : null}
        {c.skuCeilings.length > 0 ? (
          <ul className="mt-3 divide-y divide-stone-100 rounded-md border border-stone-200">
            {c.skuCeilings.map((s) => (
              <li key={s.skuId} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <bdi dir="ltr" className="font-mono">{s.code}</bdi>
                <span className="flex items-center gap-3">
                  <span>{t('pricing.percent', { value: format.number(s.ceiling) })}</span>
                  <Button variant="ghost" size="sm" onClick={() => setSku.run({ skuId: s.skuId, ceiling: null })}>{t('pricing.useDefault')}</Button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <form className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_8rem_auto]" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const ceiling = decimalText(formText(new FormData(e.currentTarget), 'skuCeiling'));
          if (skuId && ceiling) setSku.run({ skuId, ceiling });
        }}>
          <Input value={skuSearch} onChange={(e) => setSkuSearch(e.target.value)} placeholder={t('pricing.findSku')} aria-label={t('pricing.findSku')} />
          <Select value={skuId} onChange={(e) => setSkuId(e.target.value)} aria-label={t('pricing.sku')}>
            <option value="">{t('common.choose')}</option>
            {skus.data?.items.map((s) => <option key={s.id} value={s.id}>{`${s.code} · ${format.name(s.product)}`}</option>)}
          </Select>
          <Input name="skuCeiling" inputMode="decimal" dir="ltr" aria-label={t('pricing.ceiling')} />
          <Button type="submit" variant="secondary" disabled={!skuId || setSku.isPending}>{t('pricing.setSkuCeiling')}</Button>
        </form>
      </div>
    </Section>
  );
}

function PercentField({ id, label, hint, value }: { id: string; label: string; hint: string; value: string }) {
  return (
    <Field id={id} label={label} hint={hint}>
      <Input id={id} name={id} inputMode="decimal" dir="ltr" defaultValue={value} />
    </Field>
  );
}
