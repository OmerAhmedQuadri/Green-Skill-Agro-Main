'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button } from '@gsa/ui';
import type { BatchStock, SkuStock } from '@/components/procurement/types';
import { PageHeader } from '@/components/common/PageHeader';
import { Facts, Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { ConvertPanel } from '@/components/warehouse/ConvertPanel';
import type { WarehouseCan } from '@/components/warehouse/types';
import { WriteOffPanel } from '@/components/warehouse/WriteOffPanel';

/** STK-001: one SKU's stock, batch by batch — LOT, manufacture, expiry — in first-expiry-first-out order. */
export function SkuStockView({ skuId, can }: { skuId: string; can: WarehouseCan }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [acting, setActing] = useState<{ kind: 'convert' | 'writeOff'; batchId: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const data = useQuery({ queryKey: keys.skuStock(skuId), queryFn: () => api<{ sku: SkuStock; batches: BatchStock[] }>(`/stock/${skuId}`) });
  const done = (message: string | null) => {
    setActing(null);
    if (!message) return;
    setNotice(message);
    void queryClient.invalidateQueries({ queryKey: ['sku-stock'] });
    void queryClient.invalidateQueries({ queryKey: keys.stock() });
  };
  if (data.error) return <Alert>{errorText(data.error)}</Alert>;
  if (!data.data) return <p className="text-sm text-stone-500">{t('common.loading')}</p>;
  const { sku, batches } = data.data;
  const actingOn = acting ? batches.find((b) => b.batchId === acting.batchId) : undefined;
  const actionsFor = (b: BatchStock) => (b.positions.warehouse > 0 && (can.convert || can.writeOff) ? (
    <span className="inline-flex gap-1">
      {can.convert ? <Button variant="ghost" size="sm" onClick={() => { setNotice(null); setActing({ kind: 'convert', batchId: b.batchId }); }}>{t('warehouse.convert')}</Button> : null}
      {can.writeOff ? <Button variant="ghost" size="sm" onClick={() => { setNotice(null); setActing({ kind: 'writeOff', batchId: b.batchId }); }}>{t('warehouse.writeOff')}</Button> : null}
    </span>
  ) : null);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader back={{ href: '/console/stock', label: t('stock.title') }}
        title={<bdi dir="ltr" className="font-mono">{sku.code}</bdi>}
        subtitle={`${format.name(sku.product)}${sku.variety ? ` · ${format.name(sku.variety)}` : ''} · ${format.size(sku.size, sku.countUnit)}`} />
      <Section title={t('stock.positions')}>
        <Facts items={[
          { label: t('stock.warehouse'), value: format.number(sku.positions.warehouse) },
          { label: t('stock.vehicles'), value: format.number(sku.positions.vehicles) },
          { label: t('stock.dispatched'), value: format.number(sku.positions.dispatched) },
          { label: t('stock.total'), value: format.number(sku.positions.total) },
          { label: t('stock.inTransit'), value: format.number(sku.incoming.inTransit) },
          { label: t('stock.onOrder'), value: format.number(sku.incoming.onOrder) },
        ]} />
      </Section>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {acting?.kind === 'convert' && actingOn ? (
        <ConvertPanel sku={sku} batch={actingOn} held={actingOn.positions.warehouse} canPrice={can.price}
          onDone={(r) => done(r ? t('warehouse.converted', { from: r.sourcePacks, to: r.targetPacks, code: r.targetCode }) : null)} />
      ) : null}
      {acting?.kind === 'writeOff' && actingOn ? (
        <WriteOffPanel batch={actingOn} onDone={(w) => done(w ? t('warehouse.writeOffSubmitted', { number: w.number }) : null)} />
      ) : null}
      <Section title={t('stock.batches')} description={t('stock.batchesHint')}>
        {batches.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('stock.noBatches')}</p> : (
          <Table head={[t('receiving.lotNumber'), t('receiving.manufacturedOn'), t('receiving.expiresOn'), t('stock.received'), t('stock.warehouse'), t('stock.vehicles'), t('stock.dispatched'), t('stock.total'), '']}>
            {batches.map((b) => (
              <tr key={b.batchId}>
                <Cell><bdi dir="ltr" className="font-mono">{b.lotNumber ?? '—'}</bdi></Cell>
                <Cell>{b.manufacturedOn ? format.date(b.manufacturedOn) : '—'}</Cell>
                <Cell>{b.expiresOn ? format.date(b.expiresOn) : '—'}</Cell>
                <Cell>{format.dateTime(b.firstReceivedAt)}</Cell>
                <Cell>{format.number(b.positions.warehouse)}</Cell>
                <Cell>{format.number(b.positions.vehicles)}</Cell>
                <Cell>{format.number(b.positions.dispatched)}</Cell>
                <Cell className="font-semibold">{format.number(b.positions.total)}</Cell>
                <Cell className="text-end">{actionsFor(b)}</Cell>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}
