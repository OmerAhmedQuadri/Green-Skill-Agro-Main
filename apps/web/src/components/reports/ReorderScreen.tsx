'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { wholeNumber } from '@/lib/forms';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { Reorder } from './types';

type Vendor = { id: string; name: string };

/**
 * Workflow O (RPT-004..006, RPT-005, PO-008): what the projection says to order
 * before the next import, and the workings behind every figure. Advisory —
 * nothing is ordered until a manager converts it, and what they get is a draft
 * that still goes through the ordinary approval.
 */
export function ReorderScreen() {
  const t = useTranslations('reports');
  const format = useFormat();
  const errorText = useErrorText();
  const router = useRouter();
  const [vendorId, setVendorId] = useState('');
  const [packs, setPacks] = useState<Record<string, string>>({});

  const reorder = useQuery({ queryKey: keys.reorder, queryFn: () => api<Reorder>('/reports/reorder') });
  const vendors = useQuery({ queryKey: keys.vendors(), queryFn: () => api<{ items: Vendor[] }>('/vendors') });
  const convert = useOnceCommand((body: unknown, key) =>
    api<{ id: string; number: string }>('/reports/reorder/draft', { method: 'POST', body, idempotencyKey: key }), {
    onSuccess: (po) => router.push(`/console/purchase-orders/${po.id}`),
  });

  if (reorder.isPending) return <p className="p-5 text-sm text-stone-500">{t('loading')}</p>;
  if (reorder.error) return <div className="p-5"><Alert>{errorText(reorder.error)}</Alert></div>;

  const items = reorder.data.items;
  const toOrder = items.filter((i) => i.suggested > 0);
  const packsFor = (skuId: string, suggested: number) => packs[skuId] ?? String(suggested);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('reorderTitle')} subtitle={t('reorderSubtitle')} />

      {/* RPT-011: said before the figures, not in a footnote under them. */}
      {items.some((i) => i.guide) ? <Alert tone="warning" data-testid="guide-notice">{t('guideNotice')}</Alert> : null}
      {convert.error ? <Alert>{errorText(convert.error)}</Alert> : null}

      <Section title={t('reorderHead')}>
        {items.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('nothingForecast')}</p> : (
          <Table head={[t('item'), t('held'), t('inTransit'), t('perDay'), t('projected'), t('safety'), t('suggested')]}>
            {items.map((i) => (
              <tr key={i.skuId} data-testid={`reorder-${i.code}`}>
                <Cell>
                  <div className="font-medium">{format.name(i.product)}{i.variety ? ` — ${format.name(i.variety)}` : ''}</div>
                  <div className="text-xs text-stone-500"><bdi dir="ltr">{i.code}</bdi></div>
                </Cell>
                <Cell>{format.number(i.onHand)}</Cell>
                <Cell>{format.number(i.inTransit)}</Cell>
                <Cell>
                  <bdi dir="ltr" data-testid={`per-day-${i.code}`}>{i.perDay}</bdi>
                  <div className="text-xs text-stone-500">{t(`basis.${i.basisUsed}`)}</div>
                </Cell>
                {/* RPT-006: where the stock lands when the shipment does. */}
                <Cell>
                  <span className={i.projectedAtArrival < i.safetyLevel ? 'font-medium text-amber-700' : ''} data-testid={`projected-${i.code}`}>
                    {format.number(i.projectedAtArrival)}
                  </span>
                </Cell>
                <Cell>{format.number(i.safetyLevel)}</Cell>
                <Cell>
                  {i.suggested > 0
                    ? <Badge tone="warning" data-testid={`suggested-${i.code}`}>{format.number(i.suggested)}</Badge>
                    : <span className="text-stone-500" data-testid={`suggested-${i.code}`}>{format.number(0)}</span>}
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      {/* RPT-005: the system never places an order — this makes a draft to edit. */}
      {toOrder.length > 0 ? (
        <Card className="space-y-4 p-4">
          <h2 className="text-sm font-semibold text-stone-900">{t('convertTitle')}</h2>
          <p className="text-sm text-stone-600">{t('convertHint')}</p>
          <div className="flex flex-wrap items-end gap-3">
            <Field id="vendor" label={t('vendor')}>
              <Select id="vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                <option value="">{t('chooseVendor')}</option>
                {vendors.data?.items.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            </Field>
          </div>
          <Table head={[t('item'), t('orderPacks')]}>
            {toOrder.map((i) => (
              <tr key={i.skuId}>
                <Cell>{format.name(i.product)} <bdi dir="ltr" className="text-xs text-stone-500">{i.code}</bdi></Cell>
                <Cell>
                  <Input aria-label={t('orderPacksFor', { code: i.code })} inputMode="numeric" dir="ltr" className="w-28"
                    value={packsFor(i.skuId, i.suggested)} onChange={(e) => setPacks({ ...packs, [i.skuId]: e.target.value })} />
                </Cell>
              </tr>
            ))}
          </Table>
          <Button
            disabled={!vendorId || convert.isPending}
            data-testid="convert-to-draft"
            onClick={() => convert.run({
              vendorId,
              lines: toOrder
                .map((i) => ({ skuId: i.skuId, packs: wholeNumber(packsFor(i.skuId, i.suggested)) ?? 0 }))
                .filter((l) => l.packs > 0),
            })}
          >{t('convert')}</Button>
        </Card>
      ) : null}
    </div>
  );
}
