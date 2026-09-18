'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Alert } from '@gsa/ui';
import type { BatchStock, SkuStock } from '@/components/procurement/types';
import { PageHeader } from '@/components/common/PageHeader';
import { Facts, Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';

/** STK-001: one SKU's stock, batch by batch — LOT, manufacture, expiry — in first-expiry-first-out order. */
export function SkuStockView({ skuId }: { skuId: string }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const data = useQuery({ queryKey: keys.skuStock(skuId), queryFn: () => api<{ sku: SkuStock; batches: BatchStock[] }>(`/stock/${skuId}`) });
  if (data.error) return <Alert>{errorText(data.error)}</Alert>;
  if (!data.data) return <p className="text-sm text-stone-500">{t('common.loading')}</p>;
  const { sku, batches } = data.data;

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
      <Section title={t('stock.batches')} description={t('stock.batchesHint')}>
        {batches.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('stock.noBatches')}</p> : (
          <Table head={[t('receiving.lotNumber'), t('receiving.manufacturedOn'), t('receiving.expiresOn'), t('stock.received'), t('stock.warehouse'), t('stock.vehicles'), t('stock.dispatched'), t('stock.total')]}>
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
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}
