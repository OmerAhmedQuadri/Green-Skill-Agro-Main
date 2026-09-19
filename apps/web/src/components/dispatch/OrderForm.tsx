'use client';

import { dec, lineAmounts, percent, sumMoney, type Money, type Percent } from '@gsa/core';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input } from '@gsa/ui';
import { CreditPanel } from '@/components/stores/CreditPanel';
import { trimPercent } from '@/components/sales/SaleLinesTable';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { decimalText, wholeNumber } from '@/lib/forms';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import type { DispatchOptions, RaiseResult } from './types';

const asPercent = (text: string): Percent | null => {
  const v = decimalText(text);
  if (!v) return '0' as Percent;
  try { return percent(v); } catch { return null; }
};

/**
 * Workflow J and K (DSP-001, DSP-002, DSP-015): an order from the warehouse,
 * built like a sale — the store's price, a discount per line against the
 * tighter ceiling, a reason above it — with what the warehouse holds shown,
 * not reserved (OQ-019). Waiting orders count against the store's credit.
 */
export function OrderForm({ options: o, prefill, onDone }: { options: DispatchOptions; prefill: Record<string, number> | null; onDone: (result: RaiseResult) => void }) {
  const t = useTranslations('dispatch');
  const ts = useTranslations('sales');
  const format = useFormat();
  const errorText = useErrorText();
  const [packs, setPacks] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(prefill ?? {}).map(([k, v]) => [k, String(v)])));
  const [discounts, setDiscounts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('');
  const raise = useOnceCommand((body: unknown, key) => api<RaiseResult>('/dispatch-orders', { method: 'POST', body, idempotencyKey: key }), { onSuccess: onDone });

  const lines = o.items.map((item) => {
    const n = wholeNumber(packs[item.skuId] ?? '') ?? 0;
    const d = o.canDiscount ? asPercent(discounts[item.skuId] ?? '') : ('0' as Percent);
    return {
      item, packs: n, discount: d,
      amounts: n > 0 && d !== null ? lineAmounts(item.unitPrice, n, d) : null,
      above: d !== null && dec(d).gt(dec(item.ceiling)), overMax: d !== null && dec(d).gt(dec(o.limits.absoluteMaximum)),
    };
  });
  const chosen = lines.filter((l) => l.packs > 0);
  const total: Money = sumMoney(chosen.flatMap((l) => (l.amounts ? [l.amounts.total] : [])));
  const needsApproval = chosen.some((l) => l.above);
  const invalid = chosen.length === 0 || chosen.some((l) => l.discount === null || l.overMax);
  const available = dec(o.store.credit.available).minus(dec(o.committed));
  const overLimit = o.store.creditMode !== 'BILL_TO_BILL' && !o.store.credit.overrideAvailable && dec(total).gt(available);
  const term = search.trim().toLowerCase();
  const shown = lines.filter((l) => l.packs > 0 || !term || l.item.code.toLowerCase().includes(term)
    || l.item.product.nameEn.toLowerCase().includes(term) || l.item.product.nameAr.includes(search.trim()));

  return (
    <div className="space-y-4">
      <Card className="p-4"><CreditPanel credit={o.store.credit} /></Card>
      {o.committed !== '0.00' ? <p className="text-sm text-stone-600">{t('committed', { amount: format.money(o.committed) })}</p> : null}
      <Card>
        <div className="space-y-3 border-b border-stone-200 p-4">
          <div className="font-semibold">{t('items')}</div>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t('searchItems')} placeholder={t('searchItems')} />
        </div>
        <ul className="divide-y divide-stone-100">
          {shown.map(({ item, amounts, above, overMax, discount: d }) => (
            <li key={item.skuId} className="space-y-2 p-4" data-testid={`order-item-${item.code}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{format.name(item.product)}{item.variety ? ` — ${format.name(item.variety)}` : ''}</div>
                  <div className="text-xs text-stone-500"><bdi dir="ltr">{item.code}</bdi>{` · ${format.size(item.size, item.countUnit)} · ${t('inWarehouse', { count: item.warehousePacks })}`}</div>
                </div>
                <div className="text-end text-sm">{format.money(item.unitPrice)}</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field id={`o-packs-${item.skuId}`} label={ts('packsFor', { code: item.code })}>
                  <Input id={`o-packs-${item.skuId}`} inputMode="numeric" dir="ltr" value={packs[item.skuId] ?? ''} onChange={(e) => setPacks({ ...packs, [item.skuId]: e.target.value })} />
                </Field>
                {o.canDiscount ? (
                  <Field id={`o-disc-${item.skuId}`} label={ts('discountFor', { code: item.code })} hint={ts('ceilingNote', { ceiling: trimPercent(item.ceiling) })}>
                    <Input id={`o-disc-${item.skuId}`} inputMode="decimal" dir="ltr" value={discounts[item.skuId] ?? ''} onChange={(e) => setDiscounts({ ...discounts, [item.skuId]: e.target.value })} />
                  </Field>
                ) : null}
              </div>
              {d === null ? <p className="text-sm text-red-700">{ts('invalidDiscount')}</p> : null}
              {overMax ? <p className="text-sm text-red-700">{ts('aboveMaximum', { max: trimPercent(o.limits.absoluteMaximum) })}</p> : null}
              {above && !overMax ? <Badge tone="warning">{ts('aboveCeiling', { ceiling: trimPercent(item.ceiling) })}</Badge> : null}
              {amounts ? <p className="text-end text-sm font-medium">{format.money(amounts.total)}</p> : null}
            </li>
          ))}
        </ul>
      </Card>

      {chosen.length > 0 ? (
        <Card className="space-y-3 p-4" data-testid="order-summary">
          <div className="flex justify-between text-lg font-semibold"><span>{ts('total')}</span><span data-testid="order-total">{format.money(total)}</span></div>
          <p className="text-sm text-stone-600">{t('pendingNote')}</p>
          {overLimit ? <Alert>{ts('overLimit', { amount: format.money(available.gt(0) ? available.toFixed(2) : '0.00') })}</Alert> : null}
          {needsApproval ? (
            <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-3">
              <p className="font-semibold text-amber-900">{ts('requestTitle')}</p>
              <Field id="o-reason" label={ts('requestReason')}><Input id="o-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
            </div>
          ) : null}
          {raise.error ? <Alert>{errorText(raise.error)}</Alert> : null}
          <Button block disabled={invalid || overLimit || raise.isPending || (needsApproval && !reason.trim())} onClick={() => raise.run({
            storeId: o.store.id, lines: chosen.map((l) => ({ skuId: l.item.skuId, packs: l.packs, discount: l.discount ?? '0' })),
            approvalReason: needsApproval ? reason.trim() : null,
          })}>{raise.isPending ? ts('saving') : needsApproval ? ts('requestApproval') : t('sendOrder')}</Button>
        </Card>
      ) : null}
    </div>
  );
}
