'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Alert, Badge, Card } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { daysUntil, useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { PoStatusBadge } from './StatusBadge';
import type { IncomingLine } from './types';

/**
 * PO-004, STK-007: stock on its way — ordered, not yet here — with a
 * countdown to the expected arrival. It is never counted as stock held, and a
 * cancelled or closed order is not on this list (PO-006).
 */
export function IncomingPage() {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const incoming = useQuery({ queryKey: keys.incoming, queryFn: () => api<IncomingLine[]>('/incoming') });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('incoming.title')} subtitle={t('incoming.subtitle')} />
      <Card>
        {incoming.error ? <div className="p-4"><Alert>{errorText(incoming.error)}</Alert></div> : null}
        {incoming.isPending ? <p className="p-5 text-sm text-stone-500">{t('common.loading')}</p> : null}
        {incoming.data?.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('incoming.empty')}</p> : null}
        {incoming.data && incoming.data.length > 0 ? (
          <Table head={[t('incoming.arrival'), t('procurement.number'), t('catalogue.skuCode'), t('catalogue.product'), t('catalogue.packSize'), t('incoming.packs'), t('common.status')]}>
            {incoming.data.map((l) => {
              const days = l.expectedArrival ? daysUntil(l.expectedArrival) : null;
              return (
                <tr key={`${l.poId}-${l.skuId}`}>
                  <Cell>
                    {l.expectedArrival ? format.date(l.expectedArrival) : '—'}
                    {days !== null ? (
                      <div className="mt-1">
                        <Badge tone={days < 0 ? 'danger' : days <= 3 ? 'warning' : 'neutral'}>
                          {days < 0 ? t('procurement.overdueBy', { count: -days }) : days === 0 ? t('incoming.today') : t('procurement.arrivesIn', { count: days })}
                        </Badge>
                      </div>
                    ) : null}
                  </Cell>
                  <Cell>
                    <Link href={`/console/purchase-orders/${l.poId}`} className="font-mono text-brand-800 hover:underline"><bdi dir="ltr">{l.number}</bdi></Link>
                    <div className="text-xs text-stone-500"><bdi dir="ltr">{l.vendorCode}</bdi></div>
                  </Cell>
                  <Cell><bdi dir="ltr" className="font-mono">{l.code}</bdi></Cell>
                  <Cell>{format.name(l.product)}{l.variety ? <div className="text-xs text-stone-500">{format.name(l.variety)}</div> : null}</Cell>
                  <Cell>{format.size(l.size, l.countUnit)}</Cell>
                  <Cell className="font-medium">{format.number(l.outstandingPacks)}</Cell>
                  <Cell><PoStatusBadge po={{ status: l.status, closeReason: null }} /></Cell>
                </tr>
              );
            })}
          </Table>
        ) : null}
      </Card>
    </div>
  );
}
