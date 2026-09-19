'use client';

import { useTranslations } from 'next-intl';
import { Cell, Table } from '@/components/common/Table';
import { useFormat } from '@/lib/format';
import { trimPercent } from '@/components/sales/SaleLinesTable';
import type { DispatchOrder } from './types';

/** DSP-007, DSP-011: each line — ordered, what the warehouse holds or released, and what arrived. */
export function OrderLines({ order, showBatches = false }: { order: DispatchOrder; showBatches?: boolean }) {
  const t = useTranslations('dispatch');
  const ts = useTranslations('sales');
  const format = useFormat();
  const waiting = order.status === 'REQUESTED' || order.status === 'BEING_HANDLED';
  const received = order.lines.some((l) => l.receivedPacks !== null);
  return (
    <Table head={[ts('item'), t('ordered'), ts('unitPrice'), ts('discount'), ts('amount'), ...(waiting ? [t('warehouse')] : []), ...(received ? [t('arrived')] : [])]}>
      {order.lines.map((l) => (
        <tr key={l.id} data-testid={`order-line-${l.code}`}>
          <Cell>
            <div className="font-medium">{format.name(l.product)}{l.variety ? ` — ${format.name(l.variety)}` : ''}</div>
            <div className="text-xs text-stone-500"><bdi dir="ltr">{l.code}</bdi>{` · ${format.size(l.size, l.countUnit)}`}</div>
            {showBatches ? l.batches.map((b) => (
              <div key={b.batchId} className="text-xs text-stone-500">{ts('batchLine', { lot: b.lotNumber ?? '—', expiry: b.expiresOn ? format.date(b.expiresOn) : '—', packs: b.packs })}</div>
            )) : null}
          </Cell>
          <Cell>{format.number(l.packs)}</Cell>
          <Cell>{format.money(l.unitPrice)}</Cell>
          <Cell>{l.discount === '0.000' || l.discount === '0' ? '—' : `${trimPercent(l.discount)}%`}</Cell>
          <Cell>{format.money(l.orderedTotal)}</Cell>
          {waiting ? <Cell>{l.warehousePacks !== null && l.warehousePacks < l.packs ? <span className="text-red-700">{format.number(l.warehousePacks ?? 0)}</span> : format.number(l.warehousePacks ?? 0)}</Cell> : null}
          {received ? <Cell>{t('arrivedLine', { received: l.receivedPacks ?? 0, short: l.shortPacks ?? 0, damaged: l.damagedPacks ?? 0 })}</Cell> : null}
        </tr>
      ))}
      <tr>
        <Cell>{ts('total')}</Cell><Cell>{''}</Cell><Cell>{''}</Cell><Cell>{''}</Cell>
        <Cell className="font-semibold"><span data-testid="ordered-total">{format.money(order.orderedTotal)}</span></Cell>
        {waiting ? <Cell>{''}</Cell> : null}
        {received ? <Cell className="font-semibold"><span data-testid="sold-total">{format.money(order.sale.total)}</span></Cell> : null}
      </tr>
    </Table>
  );
}
