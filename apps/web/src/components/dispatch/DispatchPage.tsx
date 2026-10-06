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

/** ADR-0051: `REQUESTED` and `CLAIMED` are what the dashboard's "waiting for a decision" opens. */
const FILTERS = ['ALL', 'OPEN', 'REQUESTED', 'CLAIMED', 'UNCONFIRMED'] as const;
type Filter = (typeof FILTERS)[number];
const QUERY: Record<Filter, string> = {
  ALL: '', OPEN: '?open=true', REQUESTED: '?status=REQUESTED', CLAIMED: '?claimPending=true', UNCONFIRMED: '?unconfirmed=true',
};

/** RPT-009, DSP-004, DSP-014: every order — open, or released too long ago, on request — and who is handling each. */
export function DispatchPage({ canCreate, initialFilter = 'ALL' }: { canCreate: boolean; initialFilter?: string }) {
  const t = useTranslations('dispatch');
  const tc = useTranslations('common');
  const format = useFormat();
  const errorText = useErrorText();
  // All by default; a link may ask for one — the dashboard's "waiting for a decision" does (ADR-0051).
  const [filter, setFilter] = useState<Filter>(() => FILTERS.find((f) => f === initialFilter) ?? 'ALL');
  const list = useQuery({
    queryKey: keys.dispatchOrders({ filter }),
    queryFn: () => api<Page<DispatchSummary>>(`/dispatch-orders${QUERY[filter]}`),
    refetchInterval: 30_000,
  });
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')}
        actions={canCreate ? <Link href="/console/dispatch/new" className="inline-flex h-11 items-center rounded-md bg-brand-800 px-4 text-sm font-medium text-white">{t('newForSeller')}</Link> : null} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 p-4">
          <Select value={filter} aria-label={tc('status')} className="w-auto" onChange={(e) => setFilter(FILTERS.find((f) => f === e.target.value) ?? 'ALL')}>
            {FILTERS.map((f) => <option key={f} value={f}>{t(`filters.${f}`)}</option>)}
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
