'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import type { ExpiryFlag } from './types';

/**
 * EXP-001..008: batches near expiry by their category's window, and batches
 * that at the current rate of sale will not clear before they expire. A
 * manager can put a batch first in line for clearance (EXP-006).
 */
export function ExpiryPage({ canPrioritise }: { canPrioritise: boolean }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [onlyFlagged, setOnlyFlagged] = useState(true);
  const flags = useQuery({ queryKey: ['expiry-flags', onlyFlagged], queryFn: () => api<ExpiryFlag[]>(`/expiry-flags?onlyFlagged=${String(onlyFlagged)}`) });
  const prioritise = useCommand(({ batchId, prioritised }: { batchId: string; prioritised: boolean }, key) =>
    api(`/batches/${batchId}/clearance-priority`, { method: 'PUT', body: { prioritised }, idempotencyKey: key }),
  { onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['expiry-flags'] }) });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('warehouse.expiryTitle')} subtitle={t('warehouse.expirySubtitle')} />
      <Card>
        <div className="border-b border-stone-200 p-4">
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />{t('warehouse.onlyFlagged')}</label>
        </div>
        {flags.error ? <div className="p-4"><Alert>{errorText(flags.error)}</Alert></div> : null}
        {prioritise.error ? <div className="p-4"><Alert>{errorText(prioritise.error)}</Alert></div> : null}
        {flags.isPending ? <p className="p-5 text-sm text-stone-500">{t('common.loading')}</p> : null}
        {flags.data?.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('warehouse.noFlags')}</p> : null}
        {flags.data && flags.data.length > 0 ? (
          <Table head={[t('catalogue.skuCode'), t('receiving.lotNumber'), t('receiving.expiresOn'), t('warehouse.held'), t('warehouse.timeFlag'), t('warehouse.rateFlag'), '']}>
            {flags.data.map((f) => (
              <tr key={f.batchId} className={f.prioritised ? 'bg-amber-50' : ''}>
                <Cell>
                  <Link href={`/console/stock/${f.skuId}`} className="font-mono text-brand-800 hover:underline"><bdi dir="ltr">{f.code}</bdi></Link>
                  <div className="text-xs text-stone-500">{`${format.name(f.product)} · ${format.name(f.category)}`}</div>
                </Cell>
                <Cell><bdi dir="ltr">{f.lotNumber ?? '—'}</bdi></Cell>
                <Cell>
                  {format.date(f.expiresOn)}
                  <div className="text-xs text-stone-500">{f.daysLeft < 0 ? t('warehouse.expiredAgo', { count: -f.daysLeft }) : t('warehouse.daysLeft', { count: f.daysLeft })}</div>
                </Cell>
                <Cell>{format.number(f.heldPacks)}</Cell>
                <Cell>{f.time ? <Badge tone={f.daysLeft < 0 ? 'danger' : 'warning'}>{t('warehouse.withinWindow', { days: f.warningDays })}</Badge> : '—'}</Cell>
                <Cell>
                  {f.rate.flagged
                    ? <Badge tone="warning">{f.rate.reason === 'NO_RECENT_SALES' ? t('warehouse.noRecentSales') : t('warehouse.wontClear', { days: f.rate.daysToClear ?? 0 })}</Badge>
                    : f.rate.tooSoon ? <span className="text-xs text-stone-500">{t('warehouse.tooSoon')}</span> : '—'}
                  <div className="text-xs text-stone-500">{t(`warehouse.basis.${f.rate.basisUsed}`)}</div>
                </Cell>
                <Cell className="text-end">
                  {canPrioritise ? (
                    <Button size="sm" variant={f.prioritised ? 'secondary' : 'ghost'} disabled={prioritise.isPending}
                      onClick={() => prioritise.run({ batchId: f.batchId, prioritised: !f.prioritised })}>
                      {f.prioritised ? t('warehouse.unprioritise') : t('warehouse.prioritise')}
                    </Button>
                  ) : f.prioritised ? <Badge>{t('warehouse.prioritised')}</Badge> : null}
                </Cell>
              </tr>
            ))}
          </Table>
        ) : null}
      </Card>
    </div>
  );
}
