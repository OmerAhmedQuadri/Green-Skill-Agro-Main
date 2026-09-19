'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Card, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { api } from '@/lib/api';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { OrderForm } from './OrderForm';
import type { DispatchOptions } from './types';

type StoreChoice = { id: string; name: string; seller: { id: string; name: string } | null };

/** Workflow K (DSP-015, DSP-016): an order on a store's behalf — it is the store's seller's sale, and they are told at once. */
export function NewOrderPage() {
  const t = useTranslations('dispatch');
  const errorText = useErrorText();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [storeId, setStoreId] = useState('');
  const stores = useQuery({ queryKey: keys.dispatchStores(search), queryFn: () => api<StoreChoice[]>(`/dispatch-orders/stores?search=${encodeURIComponent(search)}`) });
  const options = useQuery({ queryKey: keys.dispatchOptions(storeId), queryFn: () => api<DispatchOptions>(`/dispatch-orders/options?storeId=${storeId}`), enabled: Boolean(storeId) });
  const chosen = stores.data?.find((s) => s.id === storeId);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('newForSeller')} subtitle={t('newForSellerHint')} back={{ href: '/console/dispatch', label: t('title') }} />
      <Card className="space-y-3 p-5">
        <Field id="store-search" label={t('findStore')}><Input id="store-search" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
        <Field id="store" label={t('store')}>
          <Select id="store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">{t('chooseStore')}</option>
            {(stores.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.seller ? `${s.name} — ${s.seller.name}` : s.name}</option>)}
          </Select>
        </Field>
        {chosen?.seller ? <p className="text-sm text-stone-600" data-testid="attributed-to">{t('attributedTo', { name: chosen.seller.name })}</p> : null}
      </Card>
      {options.error ? <Alert>{errorText(options.error)}</Alert> : null}
      {options.data ? (
        <OrderForm key={storeId} options={options.data} prefill={null} onDone={(r) => {
          void queryClient.invalidateQueries({ queryKey: keys.dispatchOrders() });
          router.push(r.orderId ? `/console/dispatch/${r.orderId}` : `/console/sales/${r.saleId}`);
        }} />
      ) : null}
    </div>
  );
}
