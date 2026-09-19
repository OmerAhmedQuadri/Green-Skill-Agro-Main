'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { DeliveryDocumentPanel } from './DeliveryDocumentPanel';
import { SaleLinesTable } from './SaleLinesTable';
import { SALE_TONE, type Sale } from './types';

/**
 * One sale on the seller's phone (PRC-010..015, DOC-003..005). While a
 * discount waits for a manager the screen waits too — the only way out is to
 * withdraw. Approved, the seller completes it at the store. Completed, the
 * delivery document is shared or emailed from here.
 */
export function FieldSaleScreen({ id }: { id: string }) {
  const t = useTranslations('sales');
  const ts = useTranslations('stores');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<'CASH' | 'BANK_TRANSFER'>('CASH');
  const [reference, setReference] = useState('');
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const sale = useQuery({
    queryKey: keys.sale(id), queryFn: () => api<Sale>(`/sales/${id}`),
    // PRC-012: the decision arrives while the seller waits; the document while the worker prints.
    refetchInterval: (q) => {
      const s = q.state.data;
      return s && (s.status === 'PENDING_DISCOUNT_APPROVAL' || s.document?.status === 'PENDING') ? 4_000 : false;
    },
  });
  const refresh = (s: Sale) => {
    queryClient.setQueryData(keys.sale(id), s);
    for (const k of [keys.sales(), keys.myVehicle, keys.cashInHand, keys.store(s.store.id), keys.saleOptions(s.store.id)]) void queryClient.invalidateQueries({ queryKey: k });
  };
  const act = useOnceCommand((body: { action: 'complete' | 'withdraw'; version: number; payment?: unknown }, key) =>
    api<Sale>(`/sales/${id}/${body.action}`, { method: 'POST', body: { version: body.version, ...(body.payment ? { payment: body.payment } : {}) }, idempotencyKey: key }), { onSuccess: refresh });

  if (sale.isPending) return <p className="text-sm text-stone-500">{t('loading')}</p>;
  if (sale.error) return <Alert>{errorText(sale.error)}</Alert>;
  const s = sale.data;
  const billToBill = s.store.creditMode === 'BILL_TO_BILL';
  const a = s.approval;
  const mustSend = s.sendingMode === 'COMPULSORY' && (s.document?.sends.length ?? 0) === 0 && s.document?.status !== 'FAILED';

  return (
    <div className="space-y-4 pb-6">
      <PageHeader title={s.store.name} back={{ href: '/field/sales', label: t('mySales') }} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SALE_TONE[s.status]} data-testid="sale-status">{t(`statuses.${s.status}`)}</Badge>
        {s.cancelReason ? <Badge>{t(`cancelReasons.${s.cancelReason}`)}</Badge> : null}
        <span className="text-sm text-stone-600">{format.dateTime(s.completedAt ?? s.createdAt)}</span>
      </div>

      {s.status === 'PENDING_DISCOUNT_APPROVAL' && a ? (
        <Alert tone="warning" data-testid="waiting">
          <div className="font-semibold">{t('waitingTitle')}</div>
          <div>{t('waitingHint', { time: format.dateTime(a.expiresAt) })}</div>
        </Alert>
      ) : null}
      {s.status === 'DISCOUNT_APPROVED' && a ? (
        <Alert tone="success" data-testid="approved">
          <div className="font-semibold">{a.status === 'REDUCED' ? t('reducedTitle') : t('approvedTitle')}</div>
          {a.comment ? <div>{t('decisionComment', { comment: a.comment })}</div> : null}
        </Alert>
      ) : null}
      {s.status === 'CANCELLED' ? (
        <Alert tone={s.cancelReason === 'WITHDRAWN' ? 'info' : 'warning'} data-testid="cancelled">
          <div className="font-semibold">{t(`cancelledTitles.${s.cancelReason ?? 'WITHDRAWN'}`)}</div>
          {a?.comment && s.cancelReason === 'REJECTED' ? <div>{t('decisionComment', { comment: a.comment })}</div> : null}
          <div>{t('released')}</div>
          {s.cancelReason !== 'WITHDRAWN' ? (
            <Link href={`/field/sell/${s.store.id}?from=${s.id}`} className="mt-2 inline-block font-medium underline">{t('freshSale')}</Link>
          ) : null}
        </Alert>
      ) : null}

      <Card><SaleLinesTable sale={s} /></Card>
      {s.payment ? <p className="text-sm text-stone-600">{t('paidWith', { method: ts(`methods.${s.payment.method}`), amount: format.money(s.payment.amount) })}</p> : null}
      {s.creditOverride ? <p className="text-sm text-stone-600">{t('overrideUsed', { name: s.creditOverride.grantedBy, reason: s.creditOverride.reason })}</p> : null}

      {act.error ? <Alert>{errorText(act.error)}</Alert> : null}
      {s.status === 'DISCOUNT_APPROVED' ? (
        <Card className="space-y-3 p-4">
          {billToBill ? (
            <>
              <p className="text-sm text-stone-600">{t('billToBillNote')}</p>
              <Field id="method" label={ts('method')}>
                <Select id="method" value={method} onChange={(e) => setMethod(e.target.value === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH')}>
                  <option value="CASH">{ts('methods.CASH')}</option><option value="BANK_TRANSFER">{ts('methods.BANK_TRANSFER')}</option>
                </Select>
              </Field>
              {method === 'BANK_TRANSFER' ? <Field id="reference" label={ts('reference')}><Input id="reference" dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} /></Field> : null}
            </>
          ) : null}
          <Button block disabled={act.isPending} onClick={() => act.run({
            action: 'complete', version: s.version,
            payment: billToBill ? { method, reference: method === 'BANK_TRANSFER' ? reference.trim() || null : null } : undefined,
          })}>{act.isPending ? t('saving') : t('complete')}</Button>
        </Card>
      ) : null}
      {s.status === 'PENDING_DISCOUNT_APPROVAL' || s.status === 'DISCOUNT_APPROVED' ? (
        confirmWithdraw ? (
          <Card className="space-y-3 p-4">
            <p className="text-sm">{t('withdrawConfirm')}</p>
            <div className="flex gap-2">
              <Button variant="danger" disabled={act.isPending} onClick={() => act.run({ action: 'withdraw', version: s.version })}>{t('withdraw')}</Button>
              <Button variant="ghost" onClick={() => setConfirmWithdraw(false)}>{t('keepWaiting')}</Button>
            </div>
          </Card>
        ) : <Button variant="ghost" block onClick={() => setConfirmWithdraw(true)}>{t('withdraw')}</Button>
      ) : null}

      {s.status === 'COMPLETED' ? (
        <Card className="space-y-4 p-4">
          <DeliveryDocumentPanel sale={s} canSend onChanged={refresh} />
          {mustSend ? <Alert tone="warning" data-testid="must-send">{t('sendRequired')}</Alert> : null}
          {/* DOC-004: when sending is compulsory, the seller leaves the sale only once it is sent. */}
          {mustSend ? null : (
            <Link href="/field/sales" className="inline-flex h-11 w-full items-center justify-center rounded-md bg-brand-800 text-sm font-medium text-white">{t('done')}</Link>
          )}
        </Card>
      ) : null}
    </div>
  );
}
