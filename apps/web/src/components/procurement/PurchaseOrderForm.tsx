'use client';

import { useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input, Select } from '@gsa/ui';
import type { Page, SkuSummary, VendorCode } from '@/components/catalogue/types';
import { Cell, Table } from '@/components/common/Table';
import { api, type ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { formText } from '@/lib/forms';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { PoDetail } from './types';

export type PoInput = {
  vendorId: string; expectedArrival: string | null; notes: string | null;
  lines: { skuId: string; orderedPacks: number; expectedUnitCost: string }[];
};
type DraftLine = { skuId: string; code: string; label: string; orderedPacks: string; expectedUnitCost: string };

/** PO-002: vendor, items, quantities in packs, expected unit cost per pack, expected arrival. */
export function PurchaseOrderForm({ order, submitLabel, pending, error, onSubmit, onCancel }: {
  order?: PoDetail; submitLabel: string; pending: boolean; error: ApiError | null; onSubmit: (input: PoInput) => void; onCancel: () => void;
}) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const vendorCodes = useQuery({ queryKey: keys.vendorCodes, queryFn: () => api<VendorCode[]>('/vendor-codes') });
  const [lines, setLines] = useState<DraftLine[]>(() => (order?.lines ?? []).map((l) => ({
    skuId: l.skuId, code: l.code, label: format.name(l.product), orderedPacks: String(l.orderedPacks), expectedUnitCost: l.expectedUnitCost,
  })));
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search);
  const skus = useQuery({
    queryKey: keys.skus({ search: query, active: true }), enabled: query.length >= 2,
    queryFn: () => api<Page<SkuSummary>>(`/skus?${new URLSearchParams({ search: query, isActive: 'true', limit: '20' }).toString()}`),
  });
  const candidates = (skus.data?.items ?? []).filter((s) => !lines.some((l) => l.skuId === s.id));

  const add = (s: SkuSummary) => {
    setLines((ls) => [...ls, { skuId: s.id, code: s.code, label: `${format.name(s.product)}${s.variety ? ` · ${format.name(s.variety)}` : ''}`, orderedPacks: '', expectedUnitCost: '' }]);
    setSearch('');
  };
  const edit = (skuId: string, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.skuId === skuId ? { ...l, ...patch } : l)));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    onSubmit({
      vendorId: formText(f, 'vendorId'), expectedArrival: formText(f, 'expectedArrival') || null, notes: formText(f, 'notes') || null,
      lines: lines.map((l) => ({ skuId: l.skuId, orderedPacks: /^\d+$/.test(l.orderedPacks) ? Number.parseInt(l.orderedPacks, 10) : 0, expectedUnitCost: l.expectedUnitCost.trim() })),
    });
  };

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {error ? <Alert>{errorText(error)}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="po-vendor" label={t('procurement.vendor')}>
          <Select id="po-vendor" name="vendorId" defaultValue={order?.vendor.id ?? ''} dir="ltr" required>
            <option value="">{t('common.choose')}</option>
            {vendorCodes.data?.map((v) => <option key={v.id} value={v.id}>{v.code}</option>)}
          </Select>
        </Field>
        <Field id="po-arrival" label={t('procurement.expectedArrival')}>
          <Input id="po-arrival" name="expectedArrival" type="date" dir="ltr" defaultValue={order?.expectedArrival ?? ''} />
        </Field>
        <Field id="po-notes" label={t('procurement.notes')}>
          <Input id="po-notes" name="notes" maxLength={1000} defaultValue={order?.notes ?? ''} />
        </Field>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">{t('procurement.lines')}</h3>
        {lines.length > 0 ? (
          <Table head={[t('catalogue.skuCode'), t('catalogue.product'), t('procurement.orderedPacks'), t('procurement.expectedUnitCost'), '']}>
            {lines.map((l) => (
              <tr key={l.skuId}>
                <Cell><bdi dir="ltr" className="font-mono">{l.code}</bdi></Cell>
                <Cell>{l.label}</Cell>
                <Cell><Input value={l.orderedPacks} onChange={(e) => edit(l.skuId, { orderedPacks: e.target.value.trim() })} inputMode="numeric" dir="ltr" className="w-24" aria-label={t('procurement.packsFor', { code: l.code })} /></Cell>
                <Cell><Input value={l.expectedUnitCost} onChange={(e) => edit(l.skuId, { expectedUnitCost: e.target.value })} inputMode="decimal" dir="ltr" className="w-28" aria-label={t('procurement.costFor', { code: l.code })} /></Cell>
                <Cell className="text-end">
                  <Button variant="ghost" size="sm" onClick={() => setLines((ls) => ls.filter((x) => x.skuId !== l.skuId))} aria-label={t('procurement.removeLine', { code: l.code })}>
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </Cell>
              </tr>
            ))}
          </Table>
        ) : <p className="text-sm text-stone-500">{t('procurement.noLines')}</p>}
        <div className="max-w-md space-y-1">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('procurement.addSku')} aria-label={t('procurement.addSku')} />
          {candidates.length > 0 ? (
            <ul className="divide-y divide-stone-100 rounded-md border border-stone-200 bg-white shadow-xs">
              {candidates.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => add(s)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-sm hover:bg-stone-50">
                    <span><bdi dir="ltr" className="font-mono">{s.code}</bdi>{' · '}{format.name(s.product)}</span>
                    <span className="text-stone-500">{format.size(s.size, s.countUnit)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending || lines.length === 0}>{pending ? t('common.saving') : submitLabel}</Button>
        <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}
