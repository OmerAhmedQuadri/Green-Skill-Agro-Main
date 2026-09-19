'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input, Select } from '@gsa/ui';
import type { Page, SkuSummary } from '@/components/catalogue/types';
import type { BatchStock, SkuStock } from '@/components/procurement/types';
import { Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { formText, wholeNumber } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { ConversionRecord } from './types';

const whole = (v: string) => wholeNumber(v);

/**
 * Workflow D (CNV-001..011): from this batch into another SKU of the same
 * variety and measure. Enter any two of packs from, packs made and loss — the
 * third is worked out, and quantities that do not balance are refused.
 */
export function ConvertPanel({ sku, batch, held, canPrice, onDone }: {
  sku: Pick<SkuStock, 'skuId' | 'productId' | 'varietyId' | 'size' | 'countUnit'>; batch: Pick<BatchStock, 'batchId' | 'lotNumber'>;
  /** Packs of the batch where the converter works — the warehouse, or their own vehicle (CNV-009). */ held: number;
  canPrice: boolean; onDone: (done: ConversionRecord | null) => void;
}) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const targets = useQuery({
    queryKey: keys.skus({ product: sku.productId, active: true }),
    queryFn: () => api<Page<SkuSummary>>(`/skus?${new URLSearchParams({ productId: sku.productId, isActive: 'true', limit: '200' }).toString()}`),
  });
  // CNV-002, CNV-010: same product and variety, same measure, not itself.
  const options = (targets.data?.items ?? []).filter((s) => s.id !== sku.skuId && (s.variety?.id ?? null) === sku.varietyId && s.size.measure === sku.size.measure);
  const [targetId, setTargetId] = useState('');
  const convert = useCommand((body: unknown, key) => api<ConversionRecord>('/conversions', { method: 'POST', body, idempotencyKey: key }), { onSuccess: onDone });
  const lossUnit = sku.size.measure === 'WEIGHT' ? t('format.gramUnit') : t(sku.countUnit === 'SEED' ? 'warehouse.seedsUnit' : 'warehouse.piecesUnit');

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    convert.run({
      sourceBatchId: batch.batchId, targetSkuId: targetId, reason: formText(f, 'reason'),
      sourcePacks: whole(formText(f, 'sourcePacks')), targetPacks: whole(formText(f, 'targetPacks')), loss: formText(f, 'loss') || null,
      targetBasePrice: formText(f, 'targetBasePrice') || null,
    });
  };

  return (
    <Section title={t('warehouse.convertTitle', { lot: batch.lotNumber ?? '—' })} description={t('warehouse.convertHint')}>
      <form className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3" noValidate onSubmit={submit}>
        {convert.error ? <Alert className="sm:col-span-2 lg:col-span-3">{errorText(convert.error)}</Alert> : null}
        <Field id="cv-target" label={t('warehouse.targetSku')}>
          <Select id="cv-target" value={targetId} onChange={(e) => setTargetId(e.target.value)} required>
            <option value="">{t('common.choose')}</option>
            {options.map((s) => <option key={s.id} value={s.id}>{`${s.code} · ${format.size(s.size, s.countUnit)} · ${t(`catalogue.packagingValues.${s.packaging}`)}`}</option>)}
          </Select>
        </Field>
        <Field id="cv-source" label={t('warehouse.sourcePacks', { held })}>
          <Input id="cv-source" name="sourcePacks" inputMode="numeric" dir="ltr" />
        </Field>
        <Field id="cv-made" label={t('warehouse.targetPacks')}><Input id="cv-made" name="targetPacks" inputMode="numeric" dir="ltr" /></Field>
        <Field id="cv-loss" label={t('warehouse.loss', { unit: lossUnit })} hint={t('warehouse.lossHint')}>
          <Input id="cv-loss" name="loss" inputMode="decimal" dir="ltr" />
        </Field>
        <Field id="cv-reason" label={t('warehouse.reason')}><Input id="cv-reason" name="reason" required maxLength={500} /></Field>
        {canPrice ? (
          <Field id="cv-price" label={t('warehouse.targetPrice')} hint={t('warehouse.targetPriceHint')}>
            <Input id="cv-price" name="targetBasePrice" inputMode="decimal" dir="ltr" />
          </Field>
        ) : null}
        <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
          <Button type="submit" disabled={convert.isPending || !targetId}>{convert.isPending ? t('common.saving') : t('warehouse.convert')}</Button>
          <Button variant="ghost" onClick={() => onDone(null)}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Section>
  );
}
