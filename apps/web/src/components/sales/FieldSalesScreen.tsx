'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Alert, Badge, Card } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { SalesMonth } from '@/components/returns/types';
import { SALE_TONE, type Page, type SaleSummary } from './types';

/** The seller's own sales, newest first — waiting ones stand out (PRC-010). */
export function FieldSalesScreen() {
  const t = useTranslations('sales');
  const format = useFormat();
  const errorText = useErrorText();
  const list = useQuery({ queryKey: keys.sales({ mine: true }), queryFn: () => api<Page<SaleSummary>>('/sales?limit=50'), refetchInterval: 15_000 });
  // RET-009: the month's sales, less the credit notes raised on them.
  const month = useQuery({ queryKey: keys.salesMonth, queryFn: () => api<SalesMonth>('/sales/month') });
  return (
    <div className="space-y-4">
      <PageHeader title={t('mySales')} />
      {month.data ? (
        <Card className="grid grid-cols-3 gap-2 p-4 text-center text-sm" data-testid="sales-month">
          <div><div className="text-stone-500">{t('monthSold')}</div><div className="font-semibold" data-testid="month-sold">{format.money(month.data.sold)}</div></div>
          <div><div className="text-stone-500">{t('monthReturned')}</div><div className="font-semibold" data-testid="month-returned">{format.money(month.data.returned)}</div></div>
          <div><div className="text-stone-500">{t('monthNet')}</div><div className="font-semibold" data-testid="month-net">{format.money(month.data.net)}</div></div>
        </Card>
      ) : null}
      <p className="text-sm text-stone-600">{t('startFromStore')} <Link href="/field/stores" className="font-medium text-brand-800 underline">{t('toStores')}</Link></p>
      {list.error ? <Alert>{errorText(list.error)}</Alert> : null}
      {list.data?.items.length === 0 ? <p className="text-sm text-stone-500">{t('noSales')}</p> : null}
      <ul className="space-y-2">
        {list.data?.items.map((s) => (
          <li key={s.id}>
            <Link href={s.dispatchOrderId && s.status !== 'DISCOUNT_APPROVED' && s.status !== 'PENDING_DISCOUNT_APPROVAL' ? `/field/orders/${s.dispatchOrderId}` : `/field/sales/${s.id}`} className="block">
              <Card className="flex items-center justify-between gap-3 p-4" data-testid={`sale-${s.id}`}>
                <div className="min-w-0">
                  <div className="truncate font-medium">{s.store.name}</div>
                  <div className="text-xs text-stone-500">{format.dateTime(s.completedAt ?? s.createdAt)}{s.documentNumber ? <>{' · '}<bdi dir="ltr">{s.documentNumber}</bdi></> : null}</div>
                </div>
                <div className="text-end">
                  <div className="font-semibold">{format.money(s.total)}</div>
                  <Badge tone={SALE_TONE[s.status]}>{t(`statuses.${s.status}`)}</Badge>
                  {s.channel === 'DISPATCH' ? <div className="text-xs text-stone-500">{t('fromWarehouse')}</div> : null}
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
