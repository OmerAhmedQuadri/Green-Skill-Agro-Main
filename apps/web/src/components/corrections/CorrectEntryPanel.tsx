'use client';

import { businessDate, dec, toMoney } from '@gsa/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Checkbox, Field, Input, Select, Textarea } from '@gsa/ui';
import type { LedgerEntry } from '@/components/stores/types';
import { Cell, Table } from '@/components/common/Table';
import { api, type ApiError } from '@/lib/api';
import { decimalText } from '@/lib/forms';
import { useFormat } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';

type Effect = {
  stores: { id: string; name: string; owed: { before: string; after: string }; pastDue: { before: string; after: string } }[];
  cashInHand: { seller: { id: string; name: string }; before: string; after: string } | null;
};
type Change = { amount?: string; date?: string; storeId?: string; voucherNumber?: string; remove?: boolean; cashInHand?: boolean };

/**
 * COR-002, COR-005 (ADR-0059): correcting one entry of a store's account. Only what changes is sent; its effect is
 * shown before it is confirmed; and it needs a reason of its own.
 */
export function CorrectEntryPanel({ entry, storeId, onDone, onCancel }: {
  entry: LedgerEntry; storeId: string; onDone: (number: number) => void; onCancel: () => void;
}) {
  const t = useTranslations('corrections.entry');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const kind = entry.correctable ?? 'BILL';
  const original = { amount: toMoney(dec(entry.amount).abs()), date: businessDate(new Date(entry.occurredAt)), voucherNumber: entry.voucher?.number ?? '' };
  // ADR-0059 (amended): only a cash payment taken in the app moves a collector's cash in hand, and only if chosen.
  const cashApplies = kind === 'PAYMENT' && entry.paymentMethod === 'CASH' && entry.origin === 'APP';
  const [amount, setAmount] = useState<string>(original.amount);
  const [date, setDate] = useState(original.date);
  const [toStore, setToStore] = useState(storeId);
  const [voucher, setVoucher] = useState(original.voucherNumber);
  const [remove, setRemove] = useState(false);
  const [cash, setCash] = useState(cashApplies);
  const [reason, setReason] = useState('');
  const [effect, setEffect] = useState<Effect | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const stores = useQuery({ queryKey: keys.stores(), queryFn: () => api<{ id: string; name: string }[]>('/stores') });

  const change: Change = remove ? { remove: true } : {
    ...(decimalText(amount) && !dec(decimalText(amount)).eq(dec(original.amount)) ? { amount: decimalText(amount) } : {}),
    ...(date && date !== original.date ? { date } : {}),
    ...(toStore !== storeId ? { storeId: toStore } : {}),
    ...(kind === 'PAYMENT' && voucher.trim() && voucher.trim() !== original.voucherNumber ? { voucherNumber: voucher.trim() } : {}),
  };
  const withCash: Change = cashApplies ? { ...change, cashInHand: cash } : change;
  // Anything edited after the effect was shown hides it: what is confirmed is what was seen.
  const edit = <T,>(set: (value: T) => void) => (value: T) => { set(value); setEffect(null); setPreviewError(null); };

  const showEffect = async () => {
    setPreviewError(null);
    const query = new URLSearchParams(Object.entries(withCash).map(([k, v]) => [k, String(v)]));
    try {
      setEffect(await api<Effect>(`/corrections/store-entries/${entry.id}/preview?${query.toString()}`));
    } catch (error) {
      setPreviewError(error as ApiError);
    }
  };
  const confirm = useCommand((body: Change & { reason: string }, key) =>
    api<{ correction: { number: number } }>(`/corrections/store-entries/${entry.id}`, { method: 'POST', body, idempotencyKey: key }), {
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: keys.storeCorrections });
      onDone(result.correction.number);
    },
  });

  const id = (name: string) => `correct-${entry.id}-${name}`;
  return (
    <div className="space-y-4 border-b border-stone-200 bg-amber-50/40 p-5" data-testid="correct-entry">
      <h3 className="text-sm font-semibold text-stone-900">{t('title', { kind })}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={id('amount')} label={t('amount')}>
          <Input id={id('amount')} inputMode="decimal" dir="ltr" value={amount} disabled={remove} onChange={(e) => edit(setAmount)(e.target.value)} />
        </Field>
        <Field id={id('date')} label={t('date')}>
          <Input id={id('date')} type="date" dir="ltr" value={date} max={businessDate(new Date())} disabled={remove} onChange={(e) => edit(setDate)(e.target.value)} />
        </Field>
        <Field id={id('store')} label={t('store')}>
          <Select id={id('store')} value={toStore} disabled={remove} onChange={(e) => edit(setToStore)(e.target.value)}>
            {(stores.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        {kind === 'PAYMENT' ? (
          <Field id={id('voucher')} label={t('voucher')}>
            <Input id={id('voucher')} dir="ltr" value={voucher} maxLength={60} disabled={remove} onChange={(e) => edit(setVoucher)(e.target.value)} />
          </Field>
        ) : null}
      </div>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={remove} onChange={(e) => edit(setRemove)(e.target.checked)} className="mt-0.5" />
        <span>{t('remove')}<span className="block text-xs text-stone-500">{t('removeHint')}</span></span>
      </label>
      {cashApplies ? (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={cash} onChange={(e) => edit(setCash)(e.target.checked)} className="mt-0.5" />
          <span>{t('cashInHand')}<span className="block text-xs text-stone-500">{t('cashInHandHint')}</span></span>
        </label>
      ) : null}
      <Field id={id('reason')} label={t('reason')} hint={t('reasonHint')}>
        <Textarea id={id('reason')} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </Field>

      {previewError ? <Alert>{errorText(previewError)}</Alert> : null}
      {confirm.error ? <Alert>{errorText(confirm.error)}</Alert> : null}
      {effect ? (
        <div className="rounded-md border border-stone-200 bg-white" data-testid="correct-effect">
          <div className="border-b border-stone-200 px-4 py-2 text-sm font-semibold text-stone-900">{t('effect')}</div>
          <Table head={['', t('owedNow'), t('owedAfter'), t('pastDueNow'), t('pastDueAfter')]}>
            {effect.stores.map((s) => (
              <tr key={s.id} data-testid={`correct-effect-${s.id}`}>
                <Cell className="font-medium">{s.name}</Cell>
                <Cell>{format.money(s.owed.before)}</Cell>
                <Cell className="font-semibold">{format.money(s.owed.after)}</Cell>
                <Cell>{format.money(s.pastDue.before)}</Cell>
                <Cell className="font-semibold">{format.money(s.pastDue.after)}</Cell>
              </tr>
            ))}
            {effect.cashInHand ? (
              <tr data-testid="correct-effect-cash">
                <Cell className="font-medium">{t('cash', { name: effect.cashInHand.seller.name })}</Cell>
                <Cell>{format.money(effect.cashInHand.before)}</Cell>
                <Cell className="font-semibold">{format.money(effect.cashInHand.after)}</Cell>
                <Cell /><Cell />
              </tr>
            ) : null}
          </Table>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {effect ? (
          <Button onClick={() => confirm.run({ ...withCash, reason })} disabled={confirm.isPending}>{t('confirm')}</Button>
        ) : (
          <Button variant="secondary" onClick={() => void showEffect()}>{t('preview')}</Button>
        )}
        <Button variant="ghost" onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  );
}
