'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { dec, lineAmounts, percent, sumMoney, type Money, type Percent } from '@gsa/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { CreditPanel } from '@/components/stores/CreditPanel';
import { api, ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { decimalText, wholeNumber } from '@/lib/forms';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { trimPercent } from './SaleLinesTable';
import type { Sale, SaleOptions } from './types';

const asPercent = (text: string): Percent | null => {
  const v = decimalText(text);
  if (!v) return '0' as Percent;
  try { return percent(v); } catch { return null; }
};

/**
 * Workflow I on the phone (SAL-001..006, PRC-008..016). The store's credit
 * comes first — a blocked store shows its block and reasons and nothing to
 * add. Then what is on the vehicle, at the store's price, one line per item:
 * packs and a discount, each against its ceiling. Within the ceilings the sale
 * completes; above them the seller asks, with a reason, and waits.
 */
export function SellScreen({ storeId, fromSaleId }: { storeId: string; fromSaleId: string | null }) {
  const t = useTranslations('sales');
  const errorText = useErrorText();
  const options = useQuery({ queryKey: keys.saleOptions(storeId), queryFn: () => api<SaleOptions>(`/sales/options?storeId=${storeId}`) });
  const from = useQuery({ queryKey: keys.sale(fromSaleId ?? ''), queryFn: () => api<Sale>(`/sales/${fromSaleId ?? ''}`), enabled: Boolean(fromSaleId) });

  if (options.isPending || (fromSaleId && from.isPending)) return <p className="text-sm text-stone-500">{t('loading')}</p>;
  if (options.error) return <Alert>{errorText(options.error)}</Alert>;
  const o = options.data;
  const back = { href: `/field/stores/${storeId}`, label: o.store.name };
  const storeReasons = o.store.credit.reasons.filter((r) => r.code === 'NOT_APPROVED' || r.code === 'REJECTED' || r.code === 'INACTIVE');
  const blocked = storeReasons.length > 0 || (o.store.credit.reasons.length > 0 && !o.store.credit.overrideAvailable);

  if (o.notWorking || blocked) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('sellTitle', { store: o.store.name })} back={back} />
        {o.notWorking ? (
          <Alert data-testid="not-working">
            <div className="font-semibold">{t('notWorking')}</div><div>{errorText(new ApiError(409, o.notWorking))}</div>
            <Link href="/field/today" className="mt-2 inline-block font-medium underline">{t('goToToday')}</Link>
          </Alert>
        ) : null}
        <Card className="p-4"><CreditPanel credit={o.store.credit} /></Card>
        {blocked ? <p className="text-sm text-stone-600" data-testid="cannot-sell">{t('cannotSell')}</p> : null}
      </div>
    );
  }

  return <SellForm storeId={storeId} options={o} from={from.data ?? null} back={back} />;
}

function SellForm({ storeId, options: o, from, back }: { storeId: string; options: SaleOptions; from: Sale | null; back: { href: string; label: string } }) {
  const t = useTranslations('sales');
  const ts = useTranslations('stores');
  const format = useFormat();
  const errorText = useErrorText();
  const router = useRouter();
  const queryClient = useQueryClient();
  // PRC-014: after a rejection or expiry, a fresh sale within the ceiling, pre-filled.
  const [packs, setPacks] = useState<Record<string, string>>(() => Object.fromEntries((from?.lines ?? [])
    .filter((l) => o.items.some((i) => i.skuId === l.skuId)).map((l) => [l.skuId, String(l.packs)])));
  const [discounts, setDiscounts] = useState<Record<string, string>>(() => Object.fromEntries((from?.lines ?? []).map((l) => {
    const ceiling = o.items.find((i) => i.skuId === l.skuId)?.ceiling ?? '0';
    return [l.skuId, trimPercent(dec(l.requestedDiscount).gt(dec(ceiling)) ? ceiling : l.requestedDiscount)];
  })));
  const [every, setEvery] = useState('');
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<'CASH' | 'BANK_TRANSFER'>('CASH');
  const [reference, setReference] = useState('');
  const record = useOnceCommand((body: unknown, key) => api<Sale>('/sales', { method: 'POST', body, idempotencyKey: key }), {
    onSuccess: (sale) => {
      for (const k of [keys.sales(), keys.saleOptions(storeId), keys.store(storeId), keys.myVehicle, keys.cashInHand]) void queryClient.invalidateQueries({ queryKey: k });
      router.push(`/field/sales/${sale.id}`);
    },
  });

  const lines = o.items.map((item) => {
    const n = wholeNumber(packs[item.skuId] ?? '') ?? 0;
    const d = o.canDiscount ? asPercent(discounts[item.skuId] ?? '') : ('0' as Percent);
    const amounts = n > 0 && item.unitPrice && d !== null ? lineAmounts(item.unitPrice, n, d) : null;
    const above = d !== null && dec(d).gt(dec(item.ceiling));
    const overMax = d !== null && dec(d).gt(dec(o.limits.absoluteMaximum));
    return { item, packs: n, discount: d, amounts, above, overMax, tooMany: n > item.sellablePacks };
  });
  const chosen = lines.filter((l) => l.packs > 0);
  const total: Money = sumMoney(chosen.flatMap((l) => (l.amounts ? [l.amounts.total] : [])));
  const gross: Money = sumMoney(chosen.flatMap((l) => (l.amounts ? [l.amounts.gross] : [])));
  const discount: Money = sumMoney(chosen.flatMap((l) => (l.amounts ? [l.amounts.discountAmount] : [])));
  const needsApproval = chosen.some((l) => l.above);
  const invalid = chosen.length === 0 || chosen.some((l) => l.discount === null || l.overMax || l.tooMany || !l.item.unitPrice);
  const billToBill = o.store.creditMode === 'BILL_TO_BILL';
  const overLimit = !billToBill && !o.store.credit.overrideAvailable && dec(o.store.credit.outstanding).plus(dec(total)).gt(dec(o.store.credit.limit));

  const submit = () => record.run({
    storeId,
    lines: chosen.map((l) => ({ skuId: l.item.skuId, packs: l.packs, discount: l.discount ?? '0' })),
    payment: billToBill && !needsApproval ? { method, reference: method === 'BANK_TRANSFER' ? reference.trim() || null : null } : null,
    approvalReason: needsApproval ? reason.trim() : null,
  });

  return (
    <div className="space-y-4 pb-6">
      <PageHeader title={t('sellTitle', { store: o.store.name })} back={back} />
      <Card className="p-4"><CreditPanel credit={o.store.credit} /></Card>
      {o.store.credit.overrideAvailable ? <Alert tone="warning" data-testid="released">{t('releasedForOne')}</Alert> : null}

      <Card>
        <div className="border-b border-stone-200 p-4 font-semibold">{t('items')}</div>
        {o.items.length === 0 ? <p className="p-4 text-sm text-stone-500">{t('noItems')}</p> : null}
        <ul className="divide-y divide-stone-100">
          {lines.map(({ item, amounts, above, overMax, tooMany, discount: d }) => (
            <li key={item.skuId} className="space-y-2 p-4" data-testid={`item-${item.code}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{format.name(item.product)}{item.variety ? ` — ${format.name(item.variety)}` : ''}</div>
                  <div className="text-xs text-stone-500"><bdi dir="ltr">{item.code}</bdi>{` · ${format.size(item.size, item.countUnit)} · ${t('sellable', { count: item.sellablePacks })}`}</div>
                </div>
                <div className="text-end text-sm">{item.unitPrice ? format.money(item.unitPrice) : <Badge tone="danger">{t('noPrice')}</Badge>}</div>
              </div>
              {item.unitPrice ? (
                <div className="grid grid-cols-2 gap-3">
                  <Field id={`packs-${item.skuId}`} label={t('packsFor', { code: item.code })}>
                    <Input id={`packs-${item.skuId}`} inputMode="numeric" dir="ltr" value={packs[item.skuId] ?? ''}
                      onChange={(e) => setPacks({ ...packs, [item.skuId]: e.target.value })} />
                  </Field>
                  {o.canDiscount ? (
                    <Field id={`disc-${item.skuId}`} label={t('discountFor', { code: item.code })} hint={t('ceilingNote', { ceiling: trimPercent(item.ceiling) })}>
                      <Input id={`disc-${item.skuId}`} inputMode="decimal" dir="ltr" value={discounts[item.skuId] ?? ''}
                        onChange={(e) => setDiscounts({ ...discounts, [item.skuId]: e.target.value })} />
                    </Field>
                  ) : null}
                </div>
              ) : null}
              {tooMany ? <p className="text-sm text-red-700">{t('tooMany', { count: item.sellablePacks })}</p> : null}
              {d === null ? <p className="text-sm text-red-700">{t('invalidDiscount')}</p> : null}
              {overMax ? <p className="text-sm text-red-700">{t('aboveMaximum', { max: trimPercent(o.limits.absoluteMaximum) })}</p> : null}
              {above && !overMax ? <Badge tone="warning" data-testid={`above-${item.code}`}>{t('aboveCeiling', { ceiling: trimPercent(item.ceiling) })}</Badge> : null}
              {amounts ? <p className="text-end text-sm font-medium">{format.money(amounts.total)}</p> : null}
            </li>
          ))}
        </ul>
        {o.canDiscount && o.items.length > 1 ? (
          <div className="flex items-end gap-2 border-t border-stone-200 p-4">
            <Field id="every" label={t('sameDiscount')}><Input id="every" inputMode="decimal" dir="ltr" value={every} onChange={(e) => setEvery(e.target.value)} /></Field>
            <Button variant="secondary" onClick={() => setDiscounts(Object.fromEntries(o.items.map((i) => [i.skuId, every])))}>{t('apply')}</Button>
          </div>
        ) : null}
      </Card>

      {chosen.length > 0 ? (
        <Card className="space-y-3 p-4" data-testid="sale-summary">
          <div className="flex justify-between text-sm"><span>{t('subtotal')}</span><span>{format.money(gross)}</span></div>
          <div className="flex justify-between text-sm"><span>{t('discount')}</span><span>{discount === '0.00' ? '—' : `−${format.money(discount)}`}</span></div>
          <div className="flex justify-between text-lg font-semibold"><span>{t('total')}</span><span data-testid="total">{format.money(total)}</span></div>
          {!billToBill ? <p className="text-sm text-stone-600">{t('onAccountNote', { amount: format.money(o.store.credit.available) })}</p> : null}
          {overLimit ? <Alert data-testid="over-limit">{t('overLimit', { amount: format.money(o.store.credit.available) })}</Alert> : null}

          {needsApproval ? (
            <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-3">
              <p className="font-semibold text-amber-900">{t('requestTitle')}</p>
              <p className="text-sm text-amber-900">{t('requestHint')}</p>
              <Field id="reason" label={t('requestReason')}><Input id="reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
            </div>
          ) : billToBill ? (
            <div className="space-y-3">
              <p className="text-sm text-stone-600">{t('billToBillNote')}</p>
              <Field id="method" label={ts('method')}>
                <Select id="method" value={method} onChange={(e) => setMethod(e.target.value === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH')}>
                  <option value="CASH">{ts('methods.CASH')}</option><option value="BANK_TRANSFER">{ts('methods.BANK_TRANSFER')}</option>
                </Select>
              </Field>
              {method === 'BANK_TRANSFER' ? <Field id="reference" label={ts('reference')}><Input id="reference" dir="ltr" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} /></Field> : null}
            </div>
          ) : null}

          {record.error ? <Alert>{errorText(record.error)}</Alert> : null}
          <Button block onClick={submit} disabled={invalid || overLimit || record.isPending || (needsApproval && !reason.trim())}>
            {record.isPending ? t('saving') : needsApproval ? t('requestApproval') : t('complete')}
          </Button>
        </Card>
      ) : null}
    </div>
  );
}
