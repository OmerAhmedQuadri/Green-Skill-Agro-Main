'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Alert, Badge } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { type Exposure, type Settlement } from './types';

type Page<T> = { items: T[]; nextCursor: string | null };

/**
 * Cash in the console (CSH-004, LIM-001): what every seller is carrying
 * against their ceilings, and the settlements waiting for a decision.
 */
export function CashPage() {
  const t = useTranslations('cash');
  const format = useFormat();
  const errorText = useErrorText();
  const sellers = useQuery({ queryKey: keys.sellerCash, queryFn: () => api<{ items: Exposure[] }>('/cash/sellers'), refetchInterval: 30_000 });
  const waiting = useQuery({ queryKey: keys.settlements({ status: 'SUBMITTED' }), queryFn: () => api<Page<Settlement>>('/cash/settlements?status=SUBMITTED&limit=50'), refetchInterval: 30_000 });
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} subtitle={t('consoleSubtitle')} />
      {sellers.error ? <Alert>{errorText(sellers.error)}</Alert> : null}

      <Section title={t('waitingTitle')}>
        {waiting.data?.items.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('noneWaiting')}</p> : (
          <Table head={[t('number'), t('seller'), t('route'), t('declared'), t('submitted')]}>
            {waiting.data?.items.map((s) => (
              <tr key={s.id} data-testid={`waiting-${s.number}`}>
                <Cell><Link href={`/console/cash/${s.id}`} className="font-medium underline"><bdi dir="ltr">{s.number}</bdi></Link></Cell>
                <Cell>{s.seller.name}</Cell>
                <Cell>{t(`routes.${s.route}`)}</Cell>
                <Cell>{format.money(s.declaredAmount)}</Cell>
                <Cell>{format.dateTime(s.submittedAt)}</Cell>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title={t('sellersTitle')}>
        <Table head={[t('seller'), t('inHand'), t('cashCeiling'), t('stockValue'), t('stockCeiling'), t('state')]}>
          {sellers.data?.items.map((s) => (
            <tr key={s.sellerId} data-testid={`seller-cash-${s.sellerId}`}>
              <Cell>{s.name}</Cell>
              <Cell>{format.money(s.cashInHand)}</Cell>
              <Cell>{s.ceiling.CASH_IN_HAND ? format.money(s.ceiling.CASH_IN_HAND) : '—'}</Cell>
              <Cell>{format.money(s.stockValue)}</Cell>
              <Cell>{s.ceiling.VEHICLE_STOCK_VALUE ? format.money(s.ceiling.VEHICLE_STOCK_VALUE) : '—'}</Cell>
              <Cell>
                {s.over.length === 0 ? <Badge tone="success">{t('within')}</Badge> : s.over.map((kind) => (
                  <Badge key={kind} tone="danger">{t(`over.${kind}`)}</Badge>
                ))}
              </Cell>
            </tr>
          ))}
        </Table>
      </Section>
      <p className="text-sm text-stone-600">{t('warningOnly')}</p>
    </div>
  );
}
