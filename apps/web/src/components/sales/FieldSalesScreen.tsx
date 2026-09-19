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
import { SALE_TONE, type Page, type SaleSummary } from './types';

/** The seller's own sales, newest first — waiting ones stand out (PRC-010). */
export function FieldSalesScreen() {
  const t = useTranslations('sales');
  const format = useFormat();
  const errorText = useErrorText();
  const list = useQuery({ queryKey: keys.sales({ mine: true }), queryFn: () => api<Page<SaleSummary>>('/sales?limit=50'), refetchInterval: 15_000 });
  return (
    <div className="space-y-4">
      <PageHeader title={t('mySales')} />
      <p className="text-sm text-stone-600">{t('startFromStore')} <Link href="/field/stores" className="font-medium text-brand-800 underline">{t('toStores')}</Link></p>
      {list.error ? <Alert>{errorText(list.error)}</Alert> : null}
      {list.data?.items.length === 0 ? <p className="text-sm text-stone-500">{t('noSales')}</p> : null}
      <ul className="space-y-2">
        {list.data?.items.map((s) => (
          <li key={s.id}>
            <Link href={`/field/sales/${s.id}`} className="block">
              <Card className="flex items-center justify-between gap-3 p-4" data-testid={`sale-${s.id}`}>
                <div className="min-w-0">
                  <div className="truncate font-medium">{s.store.name}</div>
                  <div className="text-xs text-stone-500">{format.dateTime(s.completedAt ?? s.createdAt)}{s.documentNumber ? <>{' · '}<bdi dir="ltr">{s.documentNumber}</bdi></> : null}</div>
                </div>
                <div className="text-end">
                  <div className="font-semibold">{format.money(s.total)}</div>
                  <Badge tone={SALE_TONE[s.status]}>{t(`statuses.${s.status}`)}</Badge>
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
