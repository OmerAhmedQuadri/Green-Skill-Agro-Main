'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { decimalText, formText, wholeNumber } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { CreditPanel } from './CreditPanel';
import { LedgerTable } from './LedgerTable';
import { STATUS_TONE, type LedgerEntry, type Payment, type Store, type StoreOptions } from './types';

/**
 * One store on the seller's phone: whether it can be sold to now and why not
 * (CRD-005), collecting a payment (CRD-003), its terms and its ledger.
 */
export function FieldStoreScreen({ id }: { id: string }) {
  const t = useTranslations('stores');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [paying, setPaying] = useState(false);
  const [method, setMethod] = useState<'CASH' | 'BANK_TRANSFER'>('CASH');
  const [editingCycle, setEditingCycle] = useState(false);
  const store = useQuery({ queryKey: keys.store(id), queryFn: () => api<Store>(`/stores/${id}`) });
  const ledger = useQuery({ queryKey: keys.storeLedger(id), queryFn: () => api<LedgerEntry[]>(`/stores/${id}/ledger`) });
  const options = useQuery({ queryKey: keys.storeOptions, queryFn: () => api<StoreOptions>('/stores/options'), enabled: editingCycle });
  const refresh = () => { for (const k of [keys.store(id), keys.storeLedger(id), keys.stores()]) void queryClient.invalidateQueries({ queryKey: k }); };
  const pay = useCommand((body: unknown, key) => api<Payment>('/payments', { method: 'POST', body, idempotencyKey: key }), { onSuccess: () => { setPaying(false); refresh(); } });
  const cycle = useCommand((body: unknown, key) => api<Store>(`/stores/${id}/credit-cycle`, { method: 'PATCH', body, idempotencyKey: key }), { onSuccess: () => { setEditingCycle(false); refresh(); } });

  if (store.isPending) return <p className="text-sm text-stone-500">{t('loading')}</p>;
  if (store.error) return <Alert>{errorText(store.error)}</Alert>;
  const s = store.data;

  const submitPayment = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    pay.run({ storeId: id, amount: decimalText(formText(f, 'amount')), method, reference: formText(f, 'reference') || null });
  };
  const submitCycle = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const creditMode = formText(f, 'creditMode');
    cycle.run({ version: s.version, creditMode, creditCycleDays: creditMode === 'CUSTOM' ? wholeNumber(formText(f, 'creditCycleDays')) : null });
  };

  return (
    <div className="space-y-4">
      <PageHeader title={s.name} back={{ href: '/field/stores', label: t('myStores') }} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[s.status]}>{t(`statuses.${s.status}`)}</Badge>
        <span className="text-sm text-stone-600">{s.ownerName}</span>
        <a href={`tel:${s.contactNumber}`} className="inline-flex items-center gap-1 text-sm text-brand-800"><Phone className="size-4" aria-hidden /><bdi dir="ltr">{s.contactNumber}</bdi></a>
      </div>
      {s.status === 'PENDING_APPROVAL' ? <Alert tone="info">{t('waitingApproval')}</Alert> : null}
      {s.status === 'REJECTED' && s.decisionReason ? <Alert>{t('rejectedBecause', { reason: s.decisionReason })}</Alert> : null}

      <Card className="p-4"><CreditPanel credit={s.credit} /></Card>
      {s.status === 'ACTIVE' ? <Link href={`/field/sell/${id}`} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-brand-800 text-base font-medium text-white"><ShoppingCart className="size-5" aria-hidden />{t('newSale')}</Link> : null}

      {pay.error ? <Alert>{errorText(pay.error)}</Alert> : null}
      {paying ? (
        <Card className="p-4">
          <form className="space-y-3" noValidate onSubmit={submitPayment} aria-label={t('collect')}>
            <Field id="pay-amount" label={t('amount')}><Input id="pay-amount" name="amount" inputMode="decimal" dir="ltr" required /></Field>
            <Field id="pay-method" label={t('method')}>
              <Select id="pay-method" value={method} onChange={(e) => setMethod(e.target.value === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH')}>
                <option value="CASH">{t('methods.CASH')}</option>
                <option value="BANK_TRANSFER">{t('methods.BANK_TRANSFER')}</option>
              </Select>
            </Field>
            {method === 'BANK_TRANSFER' ? <Field id="pay-ref" label={t('reference')}><Input id="pay-ref" name="reference" dir="ltr" maxLength={100} /></Field> : null}
            <div className="flex gap-2">
              <Button type="submit" disabled={pay.isPending}>{pay.isPending ? t('saving') : t('recordPayment')}</Button>
              <Button variant="ghost" onClick={() => setPaying(false)}>{t('cancel')}</Button>
            </div>
          </form>
        </Card>
      ) : s.status === 'ACTIVE' && s.credit.outstanding !== '0.00'
        ? <Button block variant="secondary" onClick={() => setPaying(true)}>{t('collect')}</Button> : null}

      <Card className="space-y-2 p-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-semibold">{t('terms')}</span>
          {!editingCycle ? <Button size="sm" variant="ghost" onClick={() => setEditingCycle(true)}>{t('changeCycle')}</Button> : null}
        </div>
        <p>{s.creditMode === 'CUSTOM' ? t('customCycle', { days: s.creditCycleDays ?? 0 }) : t(`modes.${s.creditMode}`)}{` · ${t('limitIs', { amount: format.money(s.creditLimit) })}`}</p>
        <p className="text-stone-600">{format.name(s.priceList)}</p>
        {editingCycle ? (
          <form className="space-y-2" noValidate onSubmit={submitCycle}>
            {cycle.error ? <Alert>{errorText(cycle.error)}</Alert> : null}
            <Field id="cy-mode" label={t('creditMode')}>
              <Select id="cy-mode" name="creditMode" defaultValue={s.creditMode}>
                {(options.data?.creditModes ?? [s.creditMode]).map((m) => <option key={m} value={m}>{t(`modes.${m}`)}</option>)}
              </Select>
            </Field>
            <Field id="cy-days" label={t('cycleDays')} hint={t('customOnly')}><Input id="cy-days" name="creditCycleDays" inputMode="numeric" dir="ltr" defaultValue={s.creditCycleDays ?? ''} /></Field>
            <div className="flex gap-2"><Button type="submit" size="sm" disabled={cycle.isPending}>{t('save')}</Button><Button size="sm" variant="ghost" onClick={() => setEditingCycle(false)}>{t('cancel')}</Button></div>
          </form>
        ) : null}
      </Card>

      <Card>
        <div className="border-b border-stone-200 p-4 font-semibold">{t('ledger')}</div>
        <LedgerTable entries={ledger.data ?? []} compact />
      </Card>
    </div>
  );
}
