'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Alert, Badge, Card } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { ReturnRecord } from './types';

/**
 * One return (RET-007..012): the credit note or replacement, its number, the
 * batches that came back and where they went, and — for a credit note — how
 * the money was settled: this sale, the store's other debts, cash back.
 */
export function ReturnDetail({ id, surface }: { id: string; surface: 'field' | 'console' }) {
  const t = useTranslations('returns');
  const format = useFormat();
  const errorText = useErrorText();
  const query = useQuery({ queryKey: keys.return(id), queryFn: () => api<ReturnRecord>(`/returns/${id}`) });
  if (query.isPending) return <p className="text-sm text-stone-500">{t('loading')}</p>;
  if (query.error) return <Alert>{errorText(query.error)}</Alert>;
  const r = query.data;
  const saleHref = surface === 'field' ? `/field/sales/${r.sale.id}` : `/console/sales/${r.sale.id}`;
  const credit = r.kind === 'CREDIT_NOTE';
  return (
    <div className={surface === 'field' ? 'space-y-4 pb-6' : 'mx-auto max-w-5xl space-y-6'}>
      <PageHeader title={r.store.name} subtitle={<bdi dir="ltr" data-testid="return-number">{r.number}</bdi>} back={{ href: saleHref, label: t('backToSale') }} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={credit ? 'warning' : 'neutral'} data-testid="return-kind">{t(`kinds.${r.kind}`)}</Badge>
        <Badge>{t(`conditions.${r.condition}`)}</Badge>
        <span className="text-sm text-stone-600">{format.dateTime(r.occurredAt)}</span>
      </div>
      <Card className="space-y-1 p-4 text-sm">
        <div>{t('processedBy', { name: r.processedBy.name })}</div>
        {r.seller.id !== r.processedBy.id ? <div>{t('sellerOfSale', { name: r.seller.name })}</div> : null}
        {r.vehicle ? <div>{t('onVehicle', { registration: r.vehicle.registration })}</div> : null}
        {r.warehouse ? <div>{t('intoWarehouse', { name: format.name(r.warehouse.name) })}</div> : null}
        {r.sale.documentNumber ? <div>{t('againstSale')}{' '}<Link href={saleHref} className="font-medium underline"><bdi dir="ltr">{r.sale.documentNumber}</bdi></Link></div> : null}
        {r.note ? <div>{t('noteLine', { note: r.note })}</div> : null}
      </Card>

      <Card>
        <Table head={[t('item'), t('batch'), t('packs'), t('outcomeHead'), ...(credit ? [t('amount')] : [t('handedOver')])]}>
          {r.lines.map((l) => (
            <tr key={l.id} data-testid={`returned-${l.code}`}>
              <Cell>
                <div className="font-medium">{format.name(l.product)}{l.variety ? ` — ${format.name(l.variety)}` : ''}</div>
                <div className="text-xs text-stone-500"><bdi dir="ltr">{l.code}</bdi></div>
              </Cell>
              <Cell><span className="text-xs">{t('lotExpiry', { lot: l.batch.lotNumber ?? '—', expiry: l.batch.expiresOn ? format.date(l.batch.expiresOn) : '—' })}</span></Cell>
              <Cell>{format.number(l.packs)}</Cell>
              <Cell><Badge tone={l.outcome === 'RESTOCK' ? 'success' : 'danger'}>{t(`outcomes.${l.outcome}`)}</Badge></Cell>
              {credit ? <Cell>{format.money(l.amount)}</Cell> : (
                <Cell>{l.replacements.map((x) => (
                  <div key={x.batchId} className="text-xs">{t('replacementLine', { packs: x.packs, lot: x.lotNumber ?? '—', expiry: x.expiresOn ? format.date(x.expiresOn) : '—' })}</div>
                ))}</Cell>
              )}
            </tr>
          ))}
        </Table>
      </Card>

      {credit ? (
        <Card className="space-y-1 p-4 text-sm" data-testid="credit-split">
          <div className="flex justify-between font-semibold"><span>{t('creditTotal')}</span><span data-testid="credit-amount">{format.money(r.amount)}</span></div>
          <div className="flex justify-between"><span>{t('toSale')}</span><span>{format.money(r.toSale)}</span></div>
          <div className="flex justify-between"><span>{t('toOtherDebts')}</span><span>{format.money(r.toOtherDebts)}</span></div>
          <div className="flex justify-between"><span>{t('refund')}</span><span data-testid="refund">{format.money(r.refund)}</span></div>
        </Card>
      ) : <Alert tone="info">{t('replacementNote')}</Alert>}
    </div>
  );
}
