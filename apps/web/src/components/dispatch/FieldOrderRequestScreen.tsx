'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Alert, Card } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { CreditPanel } from '@/components/stores/CreditPanel';
import { api, ApiError } from '@/lib/api';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { OrderForm } from './OrderForm';
import type { DispatchOptions, DispatchOrder } from './types';

/**
 * Workflow J on the phone (DSP-001, DSP-002): an order from the warehouse for
 * one of the seller's stores — credit first, as for a sale. After a short
 * delivery it opens pre-filled with what was missing (DSP-012, OQ-019).
 */
export function FieldOrderRequestScreen({ storeId, shortfallOf }: { storeId: string; shortfallOf: string | null }) {
  const t = useTranslations('dispatch');
  const ts = useTranslations('sales');
  const errorText = useErrorText();
  const router = useRouter();
  const queryClient = useQueryClient();
  const options = useQuery({ queryKey: keys.dispatchOptions(storeId), queryFn: () => api<DispatchOptions>(`/dispatch-orders/options?storeId=${storeId}`) });
  const gap = useQuery({ queryKey: keys.dispatchOrder(shortfallOf ?? ''), queryFn: () => api<DispatchOrder>(`/dispatch-orders/${shortfallOf ?? ''}`), enabled: Boolean(shortfallOf) });
  if (options.isPending || (shortfallOf && gap.isPending)) return <p className="text-sm text-stone-500">{ts('loading')}</p>;
  if (options.error) return <Alert>{errorText(options.error)}</Alert>;
  const o = options.data;
  const back = { href: `/field/stores/${storeId}`, label: o.store.name };
  const blocked = o.store.credit.reasons.some((r) => r.code === 'NOT_APPROVED' || r.code === 'REJECTED' || r.code === 'INACTIVE')
    || (o.store.credit.reasons.length > 0 && !o.store.credit.overrideAvailable);
  if (o.notWorking || blocked) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('orderTitle', { store: o.store.name })} back={back} />
        {o.notWorking ? (
          <Alert data-testid="not-working">
            <div className="font-semibold">{ts('notWorking')}</div><div>{errorText(new ApiError(409, o.notWorking))}</div>
            <Link href="/field/today" className="mt-2 inline-block font-medium underline">{ts('goToToday')}</Link>
          </Alert>
        ) : null}
        <Card className="p-4"><CreditPanel credit={o.store.credit} /></Card>
        {blocked ? <p className="text-sm text-stone-600" data-testid="cannot-order">{ts('cannotSell')}</p> : null}
      </div>
    );
  }
  const prefill: Record<string, number> | null = gap.data ? Object.fromEntries(gap.data.lines
    .map((l): [string, number] => [l.skuId, (l.shortPacks ?? 0) + (l.damagedPacks ?? 0)]).filter(([, n]) => n > 0)) : null;
  return (
    <div className="space-y-4 pb-6">
      <PageHeader title={t('orderTitle', { store: o.store.name })} back={back} />
      <OrderForm options={o} prefill={prefill} onDone={(r) => {
        for (const k of [keys.sales(), keys.dispatchOrders(), keys.dispatchOptions(storeId)]) void queryClient.invalidateQueries({ queryKey: k });
        router.push(r.orderId ? `/field/orders/${r.orderId}` : `/field/sales/${r.saleId}`);
      }} />
    </div>
  );
}
