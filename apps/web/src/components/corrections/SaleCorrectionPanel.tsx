'use client';

import { dec } from '@gsa/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Checkbox, Field, Input, Select, Textarea } from '@gsa/ui';
import { Cell, Table } from '@/components/common/Table';
import type { Sale } from '@/components/sales/types';
import { api, type ApiError } from '@/lib/api';
import { decimalText } from '@/lib/forms';
import { useFormat } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';

type Follows = { stock: boolean; document: boolean; account: boolean; cashInHand: boolean };
type Effect = {
  available: Follows;
  total: { before: string; after: string | null };
  stock: { code: string; lotNumber: string | null; place: string; packs: number }[];
  document: { number: string; version: number } | null;
  stores: { id: string; name: string; owed: { before: string; after: string }; pastDue: { before: string; after: string } }[];
  cashInHand: { seller: { id: string; name: string }; before: string; after: string } | null;
};
type Change = {
  lines?: { lineId: string; packs?: number; unitPrice?: string }[]; storeId?: string; remove?: boolean;
} & Partial<Follows>;

/**
 * COR-006 (ADR-0059): correcting a sale made in the app — each line's packs and price, its store, or the whole sale
 * away — and choosing what follows: stock, the delivery document, the store's account, and an open sale's cash in
 * hand. The effect is shown before it is confirmed, and the correction needs a reason of its own.
 */
export function SaleCorrectionPanel({ sale, onDone, onCancel }: { sale: Sale; onDone: (number: number) => void; onCancel: () => void }) {
  const t = useTranslations('corrections.sale');
  const format = useFormat();
  const errorText = useErrorText();
  const [packs, setPacks] = useState<Record<string, string>>(Object.fromEntries(sale.lines.map((l) => [l.id, String(l.packs)])));
  const [prices, setPrices] = useState<Record<string, string>>(Object.fromEntries(sale.lines.map((l) => [l.id, l.unitPrice])));
  const [toStore, setToStore] = useState(sale.store?.id ?? '');
  const [remove, setRemove] = useState(false);
  // Stock is left for the Super Admin to tick: the vehicle's count may have been put right already.
  const [follows, setFollows] = useState<Follows>({ stock: false, document: true, account: true, cashInHand: true });
  const [reason, setReason] = useState('');
  const [effect, setEffect] = useState<Effect | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const stores = useQuery({ queryKey: keys.stores(), queryFn: () => api<{ id: string; name: string }[]>('/stores'), enabled: sale.store !== null });

  const lines = sale.lines.flatMap((l) => {
    const p = Number.parseInt(packs[l.id] ?? '', 10);
    const price = decimalText(prices[l.id] ?? '');
    const change = {
      ...(Number.isInteger(p) && p !== l.packs ? { packs: p } : {}),
      ...(price && !dec(price).eq(dec(l.unitPrice)) ? { unitPrice: price } : {}),
    };
    return Object.keys(change).length > 0 ? [{ lineId: l.id, ...change }] : [];
  });
  const moved = sale.store !== null && toStore !== sale.store.id;
  const change: Change = remove ? { remove: true } : { ...(lines.length > 0 ? { lines } : {}), ...(moved ? { storeId: toStore } : {}) };
  // A sale moved to another store always takes its bill with it.
  const body: Change = { ...change, ...follows, account: follows.account || moved };
  const options: (keyof Follows)[] = [
    'stock', ...(remove ? [] : ['document' as const]), ...(sale.store ? ['account' as const] : []),
    ...(sale.open && sale.payment?.method === 'CASH' ? ['cashInHand' as const] : []),
  ];
  // Anything edited after the effect was shown hides it: what is confirmed is what was seen.
  const edit = <T,>(set: (value: T) => void) => (value: T) => { set(value); setEffect(null); setPreviewError(null); };

  const showEffect = async () => {
    setPreviewError(null);
    try {
      setEffect(await api<Effect>(`/sales/${sale.id}/corrections/preview`, { method: 'POST', body: { ...body, reason } }));
    } catch (error) {
      setPreviewError(error as ApiError);
    }
  };
  const confirm = useCommand((payload: Change & { reason: string }, key) =>
    api<{ number: number }>(`/sales/${sale.id}/corrections`, { method: 'POST', body: payload, idempotencyKey: key }), {
    onSuccess: (result) => onDone(result.number),
  });

  const id = (name: string) => `correct-sale-${name}`;
  return (
    <div className="space-y-4 bg-amber-50/40 p-5" data-testid="correct-sale">
      <p className="text-xs text-stone-500">{t('hint')}</p>
      <Table head={[t('item'), t('packs'), t('price')]}>
        {sale.lines.map((l) => (
          <tr key={l.id}>
            <Cell className="font-medium">{l.code}<div className="text-xs font-normal text-stone-500">{format.name(l.product)}</div></Cell>
            <Cell>
              <Input aria-label={t('packs')} data-testid={`correct-packs-${l.code}`} inputMode="numeric" dir="ltr" className="w-24" disabled={remove}
                value={packs[l.id] ?? ''} onChange={(e) => edit(setPacks)({ ...packs, [l.id]: e.target.value })} />
            </Cell>
            <Cell>
              <Input aria-label={t('price')} data-testid={`correct-price-${l.code}`} inputMode="decimal" dir="ltr" className="w-28" disabled={remove}
                value={prices[l.id] ?? ''} onChange={(e) => edit(setPrices)({ ...prices, [l.id]: e.target.value })} />
            </Cell>
          </tr>
        ))}
      </Table>
      {sale.store ? (
        <Field id={id('store')} label={t('store')}>
          <Select id={id('store')} value={toStore} disabled={remove} onChange={(e) => edit(setToStore)(e.target.value)}>
            {(stores.data ?? [{ id: sale.store.id, name: sale.store.name }]).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
      ) : null}
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={remove} onChange={(e) => edit(setRemove)(e.target.checked)} className="mt-0.5" />
        <span>{t('remove')}<span className="block text-xs text-stone-500">{t('removeHint')}</span></span>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-stone-900">{t('follows')}</legend>
        {options.map((o) => (
          <label key={o} className="flex items-start gap-2 text-sm">
            <Checkbox checked={o === 'account' ? follows.account || moved : follows[o]} disabled={o === 'account' && moved} data-testid={`follows-${o}`}
              onChange={(e) => edit(setFollows)({ ...follows, [o]: e.target.checked })} className="mt-0.5" />
            <span>{t(o)}<span className="block text-xs text-stone-500">{t(`${o}Hint`)}</span></span>
          </label>
        ))}
      </fieldset>

      <Field id={id('reason')} label={t('reason')} hint={t('reasonHint')}>
        <Textarea id={id('reason')} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </Field>

      {previewError ? <Alert>{errorText(previewError)}</Alert> : null}
      {confirm.error ? <Alert>{errorText(confirm.error)}</Alert> : null}
      {effect ? <SaleEffect effect={effect} hasStore={sale.store !== null} /> : null}

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

/** COR-002: what the correction moves — the sale's total, each batch's stock, the document, the stores and cash. */
function SaleEffect({ effect: e, hasStore }: { effect: Effect; hasStore: boolean }) {
  const t = useTranslations('corrections.sale');
  const tco = useTranslations('corrections.entry');
  const format = useFormat();
  return (
    <div className="space-y-3 rounded-md border border-stone-200 bg-white p-4 text-sm" data-testid="correct-sale-effect">
      <div className="font-semibold text-stone-900">{t('effect')}</div>
      <div className="flex flex-wrap gap-2" data-testid="correct-sale-total">
        <span className="text-stone-500">{t('total')}</span>
        <del className="tabular-nums text-stone-500">{format.money(e.total.before)}</del>
        <span className="font-semibold tabular-nums">{e.total.after ? format.money(e.total.after) : t('removedTotal')}</span>
      </div>
      {e.stock.length > 0 ? (
        <ul className="space-y-0.5" data-testid="correct-sale-stock">
          {e.stock.map((s, i) => (
            <li key={i}>{t(s.packs > 0 ? 'stockBack' : 'stockOut', { code: s.code, lot: s.lotNumber ?? t('noLot'), packs: Math.abs(s.packs), place: s.place })}</li>
          ))}
        </ul>
      ) : <p className="text-stone-500">{t('stockStays')}</p>}
      <p className={e.document ? '' : 'text-stone-500'}>{e.document ? t('documentVersion', { number: e.document.number, version: e.document.version }) : t('documentStays')}</p>
      {e.stores.length > 0 || e.cashInHand ? (
        <Table head={['', tco('owedNow'), tco('owedAfter'), tco('pastDueNow'), tco('pastDueAfter')]}>
          {e.stores.map((s) => (
            <tr key={s.id} data-testid={`correct-sale-store-${s.id}`}>
              <Cell className="font-medium">{s.name}</Cell>
              <Cell>{format.money(s.owed.before)}</Cell>
              <Cell className="font-semibold">{format.money(s.owed.after)}</Cell>
              <Cell>{format.money(s.pastDue.before)}</Cell>
              <Cell className="font-semibold">{format.money(s.pastDue.after)}</Cell>
            </tr>
          ))}
          {e.cashInHand ? (
            <tr data-testid="correct-sale-cash">
              <Cell className="font-medium">{t('cash', { name: e.cashInHand.seller.name })}</Cell>
              <Cell>{format.money(e.cashInHand.before)}</Cell>
              <Cell className="font-semibold">{format.money(e.cashInHand.after)}</Cell>
              <Cell /><Cell />
            </tr>
          ) : null}
        </Table>
      ) : hasStore ? <p className="text-stone-500">{t('accountStays')}</p> : null}
    </div>
  );
}
