'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Field, Input, Select } from '@gsa/ui';
import { ActiveBadge } from '@/components/common/ActiveBadge';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { CatalogueCan, PriceList, ProductDetail } from './types';

type Packaging = 'CAN' | 'POUCH' | 'BAG';
const PACKAGING: readonly Packaging[] = ['BAG', 'POUCH', 'CAN'];
type Size = { measure: 'WEIGHT'; value: string; unit: 'G' | 'KG' } | { measure: 'COUNT'; count: number };
type NewSku = { varietyId: string | null; size: Size; packaging: Packaging; code?: string; prices: { priceListId: string; price: string }[] };

/** CAT-006..010, PRC-001: the product's SKUs, each with its own size, packaging, code and price. */
export function SkusCard({ product, can, onChange }: { product: ProductDetail; can: CatalogueCan; onChange: (p: ProductDetail) => void }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const [adding, setAdding] = useState(false);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const varietyName = (id: string | null) => {
    const v = product.varieties.find((x) => x.id === id);
    return v ? format.name(v) : '—';
  };

  const update = useCommand(({ id, ...body }: { id: string; version: number; code?: string; isActive?: boolean }, key) =>
    api<ProductDetail>(`/skus/${id}`, { method: 'PATCH', body, idempotencyKey: key }),
  { onSuccess: (p) => { onChange(p); setEditingCode(null); } });

  const usesVarieties = product.productType.template.VARIETY !== 'HIDDEN';
  const canAdd = can.manageProducts && product.isActive && (!usesVarieties || product.varieties.some((v) => v.isActive));

  return (
    <Section
      title={t('catalogue.skus')}
      description={t('catalogue.skusHint')}
      actions={canAdd && !adding ? <Button variant="secondary" size="sm" onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />{t('catalogue.addSku')}</Button> : undefined}
    >
      {update.error ? <div className="p-4"><Alert>{errorText(update.error)}</Alert></div> : null}
      {adding ? <AddSkuForm product={product} canPrice={can.managePrices} onDone={(p) => { if (p) onChange(p); setAdding(false); }} /> : null}
      {product.skus.length === 0 && !adding ? (
        <p className="p-5 text-sm text-stone-500">{usesVarieties && product.varieties.length === 0 ? t('catalogue.addVarietyFirst') : t('catalogue.noSkus')}</p>
      ) : null}
      {product.skus.length > 0 ? (
        <Table head={[t('catalogue.skuCode'), ...(usesVarieties ? [t('catalogue.variety')] : []), t('catalogue.packSize'), t('catalogue.packaging'), t('catalogue.basePrice'), t('common.status'), '']}>
          {product.skus.map((s) => (
            <tr key={s.id}>
              <Cell>
                {editingCode === s.id ? (
                  <form className="flex gap-2" onSubmit={(e: FormEvent<HTMLFormElement>) => {
                    e.preventDefault();
                    update.run({ id: s.id, version: s.version, code: formText(new FormData(e.currentTarget), 'code') });
                  }}>
                    <Input name="code" defaultValue={s.code} dir="ltr" aria-label={t('catalogue.skuCode')} className="w-44 font-mono uppercase" maxLength={40} />
                    <Button type="submit" size="sm" disabled={update.isPending}>{t('common.save')}</Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditingCode(null)}>{t('common.cancel')}</Button>
                  </form>
                ) : (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <bdi dir="ltr" className="font-mono">{s.code}</bdi>
                    {s.codeOverridden ? <Badge tone="warning">{t('catalogue.customCode')}</Badge> : null}
                  </span>
                )}
              </Cell>
              {usesVarieties ? <Cell>{varietyName(s.varietyId)}</Cell> : null}
              <Cell>{format.size(s.size, product.productType.countUnit)}</Cell>
              <Cell>{t(`catalogue.packagingValues.${s.packaging}`)}</Cell>
              <Cell>{s.basePrice ? format.money(s.basePrice) : '—'}</Cell>
              <Cell><ActiveBadge active={s.isActive} /></Cell>
              <Cell className="text-end">
                {can.manageProducts && editingCode !== s.id ? (
                  <span className="inline-flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditingCode(s.id)}>{t('catalogue.editCode')}</Button>
                    <Button variant="ghost" size="sm" disabled={update.isPending} onClick={() => update.run({ id: s.id, version: s.version, isActive: !s.isActive })}>
                      {s.isActive ? t('common.deactivate') : t('common.reactivate')}
                    </Button>
                  </span>
                ) : null}
              </Cell>
            </tr>
          ))}
        </Table>
      ) : null}
    </Section>
  );
}

function AddSkuForm({ product, canPrice, onDone }: { product: ProductDetail; canPrice: boolean; onDone: (p: ProductDetail | null) => void }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const usesVarieties = product.productType.template.VARIETY !== 'HIDDEN';
  const varieties = product.varieties.filter((v) => v.isActive);
  const [varietyId, setVarietyId] = useState(usesVarieties ? (varieties[0]?.id ?? '') : '');
  const [measure, setMeasure] = useState<'WEIGHT' | 'COUNT'>(product.productType.countUnit === 'PIECE' ? 'COUNT' : 'WEIGHT');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState<'G' | 'KG'>('G');
  const [count, setCount] = useState('');
  const [packaging, setPackaging] = useState<Packaging>('BAG');
  const [override, setOverride] = useState<string | null>(null);

  const size: Size | null = measure === 'WEIGHT'
    ? (/^\d+(\.\d+)?$/.test(value) ? { measure, value, unit } : null)
    : (/^[1-9]\d*$/.test(count) ? { measure, count: Number.parseInt(count, 10) } : null);

  // CAT-008: the generated code is shown as soon as the size is known.
  const previewInput = useDeferredValue({ varietyId, size, packaging });
  const preview = useQuery({
    queryKey: ['sku-code', product.id, previewInput],
    enabled: previewInput.size !== null && (!usesVarieties || previewInput.varietyId !== ''),
    queryFn: () => {
      const s = previewInput.size;
      const qs = new URLSearchParams({ packaging: previewInput.packaging, measure: s?.measure ?? 'WEIGHT' });
      if (previewInput.varietyId) qs.set('varietyId', previewInput.varietyId);
      if (s?.measure === 'WEIGHT') { qs.set('value', s.value); qs.set('unit', s.unit); }
      if (s?.measure === 'COUNT') qs.set('count', String(s.count));
      return api<{ code: string }>(`/products/${product.id}/sku-code?${qs.toString()}`);
    },
    retry: false,
  });

  const lists = useQuery({ queryKey: keys.priceLists, queryFn: () => api<PriceList[]>('/price-lists'), enabled: canPrice });
  const create = useCommand((body: NewSku, key) =>
    api<ProductDetail>(`/products/${product.id}/skus`, { method: 'POST', body, idempotencyKey: key }), { onSuccess: onDone });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!size) return;
    const f = new FormData(event.currentTarget);
    const prices = (lists.data ?? []).filter((l) => l.isActive)
      .map((l) => ({ priceListId: l.id, price: formText(f, `price-${l.id}`) }))
      .filter((p) => p.price !== '');
    create.run({ varietyId: usesVarieties ? varietyId : null, size, packaging, ...(override !== null ? { code: override } : {}), prices });
  };

  return (
    <form onSubmit={submit} className="grid gap-4 border-b border-stone-200 p-5 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      {create.error ? <Alert className="sm:col-span-2 lg:col-span-4">{errorText(create.error)}</Alert> : null}
      {usesVarieties ? (
        <Field id="sku-variety" label={t('catalogue.variety')}>
          <Select id="sku-variety" value={varietyId} onChange={(e) => setVarietyId(e.target.value)}>
            {varieties.map((v) => <option key={v.id} value={v.id}>{format.name(v)}</option>)}
          </Select>
        </Field>
      ) : null}
      <Field id="sku-measure" label={t('catalogue.sizedBy')}>
        <Select id="sku-measure" value={measure} onChange={(e) => setMeasure(e.target.value === 'COUNT' ? 'COUNT' : 'WEIGHT')}>
          <option value="WEIGHT">{t('catalogue.byWeight')}</option>
          <option value="COUNT">{t(product.productType.countUnit === 'SEED' ? 'catalogue.bySeedCount' : 'catalogue.byPieceCount')}</option>
        </Select>
      </Field>
      {measure === 'WEIGHT' ? (
        <Field id="sku-weight" label={t('catalogue.packSize')} hint={t('catalogue.weightHint')}>
          <div className="flex gap-2">
            <Input id="sku-weight" value={value} onChange={(e) => setValue(e.target.value.trim())} inputMode="decimal" dir="ltr" required />
            <Select value={unit} onChange={(e) => setUnit(e.target.value === 'KG' ? 'KG' : 'G')} aria-label={t('catalogue.unit')} className="w-24">
              <option value="G">{t('format.gramUnit')}</option>
              <option value="KG">{t('format.kilogramUnit')}</option>
            </Select>
          </div>
        </Field>
      ) : (
        <Field id="sku-count" label={t(product.productType.countUnit === 'SEED' ? 'catalogue.seedsPerPack' : 'catalogue.piecesPerPack')}>
          <Input id="sku-count" value={count} onChange={(e) => setCount(e.target.value.trim())} inputMode="numeric" dir="ltr" required />
        </Field>
      )}
      <Field id="sku-packaging" label={t('catalogue.packaging')}>
        <Select id="sku-packaging" value={packaging} onChange={(e) => setPackaging(PACKAGING.find((p) => p === e.target.value) ?? 'BAG')}>
          {PACKAGING.map((p) => <option key={p} value={p}>{t(`catalogue.packagingValues.${p}`)}</option>)}
        </Select>
      </Field>

      <Field id="sku-code" label={t('catalogue.skuCode')} hint={override === null ? t('catalogue.codeGeneratedHint') : t('catalogue.codeOverriddenHint')}>
        <div className="flex gap-2">
          <Input id="sku-code" dir="ltr" className="font-mono uppercase" maxLength={40}
            value={override ?? preview.data?.code ?? ''} placeholder={t('catalogue.codePending')}
            onChange={(e) => setOverride(e.target.value.toUpperCase())} />
          {override !== null ? (
            <Button variant="ghost" size="sm" onClick={() => setOverride(null)} aria-label={t('catalogue.useGeneratedCode')} title={t('catalogue.useGeneratedCode')}>
              <RotateCcw className="size-4" aria-hidden />
            </Button>
          ) : null}
        </div>
      </Field>

      {canPrice ? (lists.data ?? []).filter((l) => l.isActive).map((l) => (
        <Field key={l.id} id={`price-${l.id}`} label={t('catalogue.priceOn', { list: format.name(l) })} hint={l.isBase ? t('catalogue.basePriceHint') : undefined}>
          <Input id={`price-${l.id}`} name={`price-${l.id}`} inputMode="decimal" dir="ltr" />
        </Field>
      )) : null}

      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
        <Button type="submit" disabled={create.isPending || size === null}>{create.isPending ? t('common.saving') : t('catalogue.addSku')}</Button>
        <Button variant="ghost" onClick={() => onDone(null)}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}
