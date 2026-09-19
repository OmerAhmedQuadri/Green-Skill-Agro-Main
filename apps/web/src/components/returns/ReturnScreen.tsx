'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Alert, Card } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { ReturnForm } from './ReturnForm';
import type { Returnable } from './types';

/**
 * Workflow L: goods back from one sale — on the phone at the store, onto the
 * seller's vehicle; or in the console, into a warehouse (ADR-0039).
 */
export function ReturnScreen({ saleId, surface }: { saleId: string; surface: 'field' | 'console' }) {
  const t = useTranslations('returns');
  const format = useFormat();
  const errorText = useErrorText();
  const router = useRouter();
  const queryClient = useQueryClient();
  const base = surface === 'field' ? '/field' : '/console';
  const view = useQuery({ queryKey: keys.returnable(saleId), queryFn: () => api<Returnable>(`/sales/${saleId}/returnable`) });
  if (view.isPending) return <p className="text-sm text-stone-500">{t('loading')}</p>;
  if (view.error) return <Alert>{errorText(view.error)}</Alert>;
  const r = view.data;
  return (
    <div className={surface === 'field' ? 'space-y-4 pb-6' : 'mx-auto max-w-3xl space-y-6'}>
      <PageHeader title={t('title', { store: r.sale.store.name })} back={{ href: `${base}/sales/${saleId}`, label: t('backToSale') }} />
      <Card className="space-y-1 p-4 text-sm">
        <div className="flex justify-between"><span>{t('sale')}</span><span>{r.sale.document ? <bdi dir="ltr">{r.sale.document.number}</bdi> : '—'}</span></div>
        <div className="flex justify-between"><span>{t('soldOn')}</span><span>{format.dateTime(r.sale.completedAt ?? r.sale.createdAt)}</span></div>
        <div className="flex justify-between"><span>{t('saleTotal')}</span><span>{format.money(r.sale.total)}</span></div>
        <div className="flex justify-between"><span>{t('unpaid')}</span><span data-testid="unpaid">{format.money(r.unpaid)}</span></div>
      </Card>
      <ReturnForm returnable={r} onDone={(created) => {
        for (const k of [keys.returnable(saleId), keys.returns(), keys.sale(saleId), keys.myVehicle, keys.cashInHand, keys.store(r.sale.store.id), keys.salesMonth])
          void queryClient.invalidateQueries({ queryKey: k });
        router.push(`${base}/returns/${created.id}`);
      }} />
    </div>
  );
}
