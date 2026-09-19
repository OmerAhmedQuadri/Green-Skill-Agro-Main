'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Card, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { SALE_TONE, type Page, type SaleSummary } from './types';

const STATUSES = ['PENDING_DISCOUNT_APPROVAL', 'DISCOUNT_APPROVED', 'COMPLETED', 'CANCELLED'] as const;
type Filter = '' | 'AWAITING' | (typeof STATUSES)[number];

/** PRC-012, RPT-009: requests waiting for a decision first, then every sale the viewer may see. */
export function SalesPage({ canDecide }: { canDecide: boolean }) {
  const t = useTranslations('sales');
  const tc = useTranslations('common');
  const format = useFormat();
  const errorText = useErrorText();
  const [filter, setFilter] = useState<Filter>(canDecide ? 'AWAITING' : '');
  const list = useQuery({
    queryKey: keys.sales({ filter }),
    queryFn: () => api<Page<SaleSummary>>(filter === 'AWAITING' ? '/sales?awaitingDecision=true' : filter ? `/sales?status=${filter}` : '/sales'),
    refetchInterval: filter === 'AWAITING' ? 15_000 : false,
  });
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 p-4">
          <Select value={filter} aria-label={tc('status')} className="w-auto"
            onChange={(e) => setFilter((['', 'AWAITING', ...STATUSES] as const).find((s) => s === e.target.value) ?? '')}>
            <option value="">{tc('all')}</option>
            {canDecide ? <option value="AWAITING">{t('awaitingDecision')}</option> : null}
            {STATUSES.map((s) => <option key={s} value={s}>{t(`statuses.${s}`)}</option>)}
          </Select>
        </div>
        {list.error ? <div className="p-4"><Alert>{errorText(list.error)}</Alert></div> : null}
        {list.data?.items.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('noSales')}</p> : null}
        {list.data && list.data.items.length > 0 ? (
          <Table head={[t('when'), t('store'), t('seller'), t('total'), tc('status'), t('document')]}>
            {list.data.items.map((s) => (
              <tr key={s.id} data-testid={`row-${s.store.name}`}>
                <Cell><Link href={`/console/sales/${s.id}`} className="font-medium text-brand-800 hover:underline">{format.dateTime(s.completedAt ?? s.createdAt)}</Link></Cell>
                <Cell>{s.store.name}</Cell>
                <Cell>{s.seller.name}</Cell>
                <Cell>{format.money(s.total)}{s.discount === '0.00' ? null : <div className="text-xs text-stone-500">{t('discountOf', { amount: format.money(s.discount) })}</div>}</Cell>
                <Cell>
                  <Badge tone={SALE_TONE[s.status]}>{t(`statuses.${s.status}`)}</Badge>
                  {s.status === 'PENDING_DISCOUNT_APPROVAL' && s.expiresAt ? <div className="text-xs text-stone-500">{t('expiresAt', { time: format.dateTime(s.expiresAt) })}</div> : null}
                </Cell>
                <Cell>{s.documentNumber ? <bdi dir="ltr">{s.documentNumber}</bdi> : '—'}</Cell>
              </tr>
            ))}
          </Table>
        ) : null}
      </Card>
    </div>
  );
}
