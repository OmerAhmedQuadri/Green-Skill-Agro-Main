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
import { DISPATCH_TONE, type DispatchSummary, type Page } from './types';

type Filter = 'OPEN' | 'UNCONFIRMED' | 'ALL';

/** RPT-009, DSP-004, DSP-014: open orders first, who is handling each, and the ones released too long ago. */
export function DispatchPage({ canCreate }: { canCreate: boolean }) {
  const t = useTranslations('dispatch');
  const tc = useTranslations('common');
  const format = useFormat();
  const errorText = useErrorText();
  const [filter, setFilter] = useState<Filter>('OPEN');
  const list = useQuery({
    queryKey: keys.dispatchOrders({ filter }),
    queryFn: () => api<Page<DispatchSummary>>(filter === 'OPEN' ? '/dispatch-orders?open=true' : filter === 'UNCONFIRMED' ? '/dispatch-orders?unconfirmed=true' : '/dispatch-orders'),
    refetchInterval: 30_000,
  });
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')}
        actions={canCreate ? <Link href="/console/dispatch/new" className="inline-flex h-11 items-center rounded-md bg-brand-800 px-4 text-sm font-medium text-white">{t('newForSeller')}</Link> : null} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 p-4">
          <Select value={filter} aria-label={tc('status')} className="w-auto" onChange={(e) => setFilter((['OPEN', 'UNCONFIRMED', 'ALL'] as const).find((f) => f === e.target.value) ?? 'OPEN')}>
            <option value="OPEN">{t('filters.OPEN')}</option><option value="UNCONFIRMED">{t('filters.UNCONFIRMED')}</option><option value="ALL">{t('filters.ALL')}</option>
          </Select>
        </div>
        {list.error ? <div className="p-4"><Alert>{errorText(list.error)}</Alert></div> : null}
        {list.data?.items.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('noOrders')}</p> : null}
        {list.data && list.data.items.length > 0 ? (
          <Table head={[t('number'), t('store'), t('seller'), t('total'), tc('status'), t('handledByColumn')]}>
            {list.data.items.map((o) => (
              <tr key={o.id} data-testid={`order-row-${o.number}`}>
                <Cell>
                  <Link href={`/console/dispatch/${o.id}`} className="font-medium text-brand-800 hover:underline"><bdi dir="ltr">{o.number}</bdi></Link>
                  <div className="text-xs text-stone-500">{format.dateTime(o.createdAt)}</div>
                </Cell>
                <Cell>{o.store.name}</Cell>
                <Cell>{o.seller.name}{o.raisedBy.id !== o.seller.id ? <div className="text-xs text-stone-500">{t('raisedByLine', { name: o.raisedBy.name })}</div> : null}</Cell>
                <Cell>{format.money(o.total)}</Cell>
                <Cell>
                  <Badge tone={DISPATCH_TONE[o.status]}>{t(`statuses.${o.status}`)}</Badge>
                  {o.unconfirmed ? <Badge tone="danger" className="ms-1">{t('unconfirmed')}</Badge> : null}
                  {o.pendingClaim ? <Badge tone="danger" className="ms-1">{t('claimBadge')}</Badge> : null}
                </Cell>
                <Cell>{o.handledBy?.name ?? '—'}</Cell>
              </tr>
            ))}
          </Table>
        ) : null}
      </Card>
    </div>
  );
}
