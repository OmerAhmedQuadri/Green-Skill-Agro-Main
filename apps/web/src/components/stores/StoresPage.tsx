'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Card, Checkbox, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { STATUS_TONE, type StoreSummary } from './types';

type Status = '' | 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'INACTIVE';

/** STO-006, STO-009, CRD-004: every store — who manages it, its state, what it owes and whether it is blocked. */
export function StoresPage({ canApprove }: { canApprove: boolean }) {
  const t = useTranslations('stores');
  const tc = useTranslations('common');
  const format = useFormat();
  const errorText = useErrorText();
  // Every store, whoever is looking. An approver used to land on a list
  // filtered to what awaits them, which meant the Stores page quietly showed
  // three of seventy-six and gave no sign it was hiding any.
  const [status, setStatus] = useState<Status>('');
  const [search, setSearch] = useState('');
  const [blockedOnly, setBlockedOnly] = useState(false);
  const filter = { status, search, blockedOnly };
  const list = useQuery({
    queryKey: keys.stores(filter),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (search.trim()) qs.set('search', search.trim());
      if (blockedOnly) qs.set('blocked', 'true');
      return api<StoreSummary[]>(`/stores?${qs.toString()}`);
    },
  });

  const waiting = (list.data ?? []).filter((s) => s.status === 'PENDING_APPROVAL').length;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 p-4">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t('search')} className="w-64" />
          <Select value={status} aria-label={tc('status')} className="w-auto"
            onChange={(e) => setStatus((['', 'PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'INACTIVE'] as const).find((s) => s === e.target.value) ?? '')}>
            <option value="">{tc('all')}</option>
            {(['PENDING_APPROVAL', 'ACTIVE', 'INACTIVE', 'REJECTED'] as const).map((s) => <option key={s} value={s}>{t(`statuses.${s}`)}</option>)}
          </Select>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={blockedOnly} onChange={(e) => setBlockedOnly(e.target.checked)} />{t('blockedOnly')}
          </label>
        </div>
        {/* The approver's shortcut, as a count they can act on rather than a
            filter applied on their behalf. Only shown unfiltered, where the
            number is exactly what is on screen. */}
        {canApprove && !status && waiting > 0 ? (
          <div className="border-b border-stone-200 px-4 py-2.5 text-sm">
            <button type="button" className="font-medium text-brand-800 hover:underline" onClick={() => setStatus('PENDING_APPROVAL')}>
              {t('waitingCount', { count: waiting })}
            </button>
          </div>
        ) : null}
        {list.error ? <div className="p-4"><Alert>{errorText(list.error)}</Alert></div> : null}
        {list.data?.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('noStores')}</p> : null}
        {list.data && list.data.length > 0 ? (
          <Table head={[t('name'), t('seller'), tc('status'), t('outstanding'), t('credit')]}>
            {list.data.map((s) => (
              <tr key={s.id} data-testid={`row-${s.name}`}>
                <Cell>
                  <Link href={`/console/stores/${s.id}`} className="font-medium text-brand-800 hover:underline">{s.name}</Link>
                  <div className="text-xs text-stone-500">{s.ownerName}</div>
                </Cell>
                <Cell>{s.seller?.name ?? '—'}</Cell>
                <Cell><Badge tone={STATUS_TONE[s.status]}>{t(`statuses.${s.status}`)}</Badge></Cell>
                <Cell>{format.money(s.credit.outstanding)}</Cell>
                <Cell>{s.credit.blocked ? <Badge tone="danger">{t('blocked')}</Badge> : s.credit.overridden ? <Badge tone="warning">{t('releasedToday')}</Badge> : <Badge tone="success">{t('clearShort')}</Badge>}</Cell>
              </tr>
            ))}
          </Table>
        ) : null}
      </Card>
    </div>
  );
}
