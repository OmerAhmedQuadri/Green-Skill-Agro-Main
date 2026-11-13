'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Field, Input, Select, Textarea } from '@gsa/ui';
import type { Page, SkuSummary } from '@/components/catalogue/types';
import { Cell, Table } from '@/components/common/Table';
import { api, type ApiError } from '@/lib/api';
import { decimalText } from '@/lib/forms';
import { useFormat } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';

type Line = { item: string; skuId: string | null; code: string | null; packs: string; unitPrice: string; amount: string };
type Invoice = {
  id: string; soldOn: string; serial: number; book: string; row: number; posted: boolean;
  subtotal: string; discount: string; total: string; lines: Line[];
};
type Effect = {
  total: { before: string; after: string }; posted: boolean;
  stores: { id: string; name: string; owed: { before: string; after: string }; pastDue: { before: string; after: string } }[];
};
type Draft = { item: string; skuId: string; packs: string; unitPrice: string; amount: string };

/**
 * COR-006 (ADR-0059): an imported store's invoices from the books as they stand, each correctable — its lines
 * (product, packs, price, amount) and discount — in the Super Admin's correction session. Only the bill follows,
 * when it is in the account already; before re-verification the store is shown the corrected invoice.
 */
export function ImportedInvoices({ storeId, sessionOpen }: { storeId: string; sessionOpen: boolean }) {
  const t = useTranslations('corrections.imported');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const invoices = useQuery({ queryKey: keys.importedSales(storeId), queryFn: () => api<Invoice[]>(`/stores/${storeId}/imported-sales`) });

  return (
    <div data-testid="imported-invoices">
      <p className="border-b border-stone-200 px-5 py-3 text-xs text-stone-500">{sessionOpen ? t('hint') : t('openSession')}</p>
      {invoices.error ? <div className="p-4"><Alert>{errorText(invoices.error)}</Alert></div> : null}
      {done !== null ? <div className="p-4"><Alert tone="success">{t('done', { number: done })}</Alert></div> : null}
      {invoices.data && invoices.data.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('none')}</p> : null}
      <ul className="divide-y divide-stone-100">
        {(invoices.data ?? []).map((inv) => (
          <li key={inv.id} data-testid={`imported-invoice-${inv.serial}`}>
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <div>
                <div className="font-medium">{t('invoice', { serial: inv.serial, date: format.date(inv.soldOn) })}</div>
                <div className="text-xs text-stone-500">{t('source', { book: inv.book, row: inv.row })}</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={inv.posted ? 'success' : 'neutral'}>{inv.posted ? t('posted') : t('notPosted')}</Badge>
                <span className="font-semibold tabular-nums" data-testid="imported-invoice-total">{format.money(inv.total)}</span>
                {sessionOpen && correcting !== inv.id ? (
                  <Button size="sm" variant="secondary" onClick={() => { setDone(null); setCorrecting(inv.id); }}>{t('correct')}</Button>
                ) : null}
              </div>
            </div>
            {sessionOpen && correcting === inv.id ? (
              <CorrectInvoice invoice={inv} onCancel={() => setCorrecting(null)} onDone={(number) => {
                setCorrecting(null); setDone(number);
                for (const k of [keys.importedSales(storeId), keys.storeLedger(storeId), keys.store(storeId), keys.storeImported(storeId), keys.saleCorrections]) {
                  void queryClient.invalidateQueries({ queryKey: k });
                }
              }} />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CorrectInvoice({ invoice, onDone, onCancel }: { invoice: Invoice; onDone: (number: number) => void; onCancel: () => void }) {
  const t = useTranslations('corrections.imported');
  const tco = useTranslations('corrections.entry');
  const format = useFormat();
  const errorText = useErrorText();
  const [lines, setLines] = useState<Draft[]>(invoice.lines.map((l) => ({ item: l.item, skuId: l.skuId ?? '', packs: l.packs, unitPrice: l.unitPrice, amount: l.amount })));
  const [discount, setDiscount] = useState(invoice.discount);
  const [reason, setReason] = useState('');
  const [effect, setEffect] = useState<Effect | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const skus = useQuery({ queryKey: keys.skus({ active: true, all: true }), queryFn: () => api<Page<SkuSummary>>('/skus?isActive=true&limit=200') });

  const body = {
    lines: lines.map((l) => ({
      item: l.item.trim(), skuId: l.skuId || null, packs: decimalText(l.packs) || l.packs.trim(), unitPrice: decimalText(l.unitPrice) || l.unitPrice.trim(),
      ...(decimalText(l.amount) ? { amount: decimalText(l.amount) } : {}),
    })),
    ...(decimalText(discount) ? { discount: decimalText(discount) } : {}),
  };
  const set = (i: number, patch: Partial<Draft>) => { setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l))); setEffect(null); setPreviewError(null); };
  const showEffect = async () => {
    setPreviewError(null);
    try {
      setEffect(await api<Effect>(`/imported-sales/${invoice.id}/corrections/preview`, { method: 'POST', body: { ...body, reason } }));
    } catch (error) {
      setPreviewError(error as ApiError);
    }
  };
  const confirm = useCommand((payload: typeof body & { reason: string }, key) =>
    api<{ number: number }>(`/imported-sales/${invoice.id}/corrections`, { method: 'POST', body: payload, idempotencyKey: key }), {
    onSuccess: (result) => onDone(result.number),
  });

  const id = (name: string) => `imported-${invoice.id}-${name}`;
  return (
    <div className="space-y-4 border-t border-stone-200 bg-amber-50/40 p-5" data-testid="correct-invoice">
      <Table head={[t('item'), t('product'), t('packs'), t('price'), t('amount'), '']}>
        {lines.map((l, i) => (
          <tr key={i}>
            <Cell><Input aria-label={t('item')} value={l.item} maxLength={200} onChange={(e) => set(i, { item: e.target.value })} /></Cell>
            <Cell>
              <Select aria-label={t('product')} value={l.skuId} onChange={(e) => set(i, { skuId: e.target.value })}>
                <option value="">{t('noProduct')}</option>
                {(skus.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{`${s.code} · ${format.name(s.product)}`}</option>)}
              </Select>
            </Cell>
            <Cell><Input aria-label={t('packs')} data-testid={`invoice-packs-${i}`} inputMode="decimal" dir="ltr" className="w-24" value={l.packs} onChange={(e) => set(i, { packs: e.target.value, amount: '' })} /></Cell>
            <Cell><Input aria-label={t('price')} inputMode="decimal" dir="ltr" className="w-24" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value, amount: '' })} /></Cell>
            <Cell><Input aria-label={t('amount')} inputMode="decimal" dir="ltr" className="w-28" value={l.amount} placeholder={t('amountHint')} onChange={(e) => set(i, { amount: e.target.value })} /></Cell>
            <Cell>{lines.length > 1 ? <Button size="sm" variant="ghost" onClick={() => { setLines(lines.filter((_, j) => j !== i)); setEffect(null); }}>{t('removeLine')}</Button> : null}</Cell>
          </tr>
        ))}
      </Table>
      <div className="flex flex-wrap items-end gap-4">
        <Button size="sm" variant="secondary" onClick={() => { setLines([...lines, { item: '', skuId: '', packs: '', unitPrice: '', amount: '' }]); setEffect(null); }}>{t('addLine')}</Button>
        <Field id={id('discount')} label={t('discount')}>
          <Input id={id('discount')} inputMode="decimal" dir="ltr" className="w-28" value={discount} onChange={(e) => { setDiscount(e.target.value); setEffect(null); }} />
        </Field>
      </div>
      <Field id={id('reason')} label={t('reason')} hint={t('reasonHint')}>
        <Textarea id={id('reason')} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </Field>

      {previewError ? <Alert>{errorText(previewError)}</Alert> : null}
      {confirm.error ? <Alert>{errorText(confirm.error)}</Alert> : null}
      {effect ? (
        <div className="space-y-3 rounded-md border border-stone-200 bg-white p-4 text-sm" data-testid="correct-invoice-effect">
          <div className="font-semibold text-stone-900">{t('effect')}</div>
          <div className="flex flex-wrap gap-2 tabular-nums">
            <span className="text-stone-500">{t('total')}</span><del className="text-stone-500">{format.money(effect.total.before)}</del>
            <span className="font-semibold">{format.money(effect.total.after)}</span>
          </div>
          {effect.posted ? (
            <Table head={['', tco('owedNow'), tco('owedAfter'), tco('pastDueNow'), tco('pastDueAfter')]}>
              {effect.stores.map((s) => (
                <tr key={s.id}>
                  <Cell className="font-medium">{s.name}</Cell>
                  <Cell>{format.money(s.owed.before)}</Cell>
                  <Cell className="font-semibold">{format.money(s.owed.after)}</Cell>
                  <Cell>{format.money(s.pastDue.before)}</Cell>
                  <Cell className="font-semibold">{format.money(s.pastDue.after)}</Cell>
                </tr>
              ))}
            </Table>
          ) : <p className="text-stone-500">{t('notPostedEffect')}</p>}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {effect ? (
          <Button onClick={() => confirm.run({ ...body, reason })} disabled={confirm.isPending}>{t('confirm')}</Button>
        ) : (
          <Button variant="secondary" onClick={() => void showEffect()}>{t('preview')}</Button>
        )}
        <Button variant="ghost" onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  );
}
