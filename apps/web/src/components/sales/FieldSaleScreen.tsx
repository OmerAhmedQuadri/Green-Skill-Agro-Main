'use client';

import { sumMoney, type Money } from '@gsa/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { NO_PAYMENT, PaymentFields, paymentBody, type PaymentDraft } from '@/components/stores/PaymentFields';
import type { Store } from '@/components/stores/types';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { SaleReturns } from '@/components/returns/SaleReturns';
import { DeliveryDocumentPanel } from './DeliveryDocumentPanel';
import { partyOf } from './party';
import { SaleLinesTable } from './SaleLinesTable';
import { SALE_TONE, type Sale } from './types';

/**
 * One sale on the seller's phone (PRC-010..015, DOC-003..005). While a
 * discount waits for a manager the screen waits too — the only way out is to
 * withdraw. Approved, the seller completes it at the store. Completed, the
 * delivery document is shared or emailed from here.
 */
export function FieldSaleScreen({ id, canReturn = false }: { id: string; canReturn?: boolean }) {
  const t = useTranslations('sales');
  const ts = useTranslations('stores');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [paying, setPaying] = useState(false);
  const [draft, setDraft] = useState<PaymentDraft>(NO_PAYMENT);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const sale = useQuery({
    queryKey: keys.sale(id), queryFn: () => api<Sale>(`/sales/${id}`),
    // PRC-012: the decision arrives while the seller waits; the document while the worker prints.
    refetchInterval: (q) => {
      const s = q.state.data;
      return s && (s.status === 'PENDING_DISCOUNT_APPROVAL' || s.document?.status === 'PENDING') ? 4_000 : false;
    },
  });
  // ADR-0047: what the store owes besides, for money taken as an approved sale completes.
  const completing = sale.data?.status === 'DISCOUNT_APPROVED' && sale.data.channel === 'VEHICLE';
  const storeId = sale.data?.store?.id ?? '';
  const store = useQuery({ queryKey: keys.store(storeId), queryFn: () => api<Store>(`/stores/${storeId}`), enabled: completing && Boolean(storeId) });
  const refresh = (s: Sale) => {
    queryClient.setQueryData(keys.sale(id), s);
    const own = s.store ? [keys.store(s.store.id), keys.saleOptions(s.store.id)] : [keys.openSaleOptions];
    for (const k of [keys.sales(), keys.myVehicle, keys.cashInHand, ...own]) void queryClient.invalidateQueries({ queryKey: k });
  };
  const act = useOnceCommand((body: { action: 'complete' | 'withdraw'; version: number; payment?: unknown }, key) =>
    api<Sale>(`/sales/${id}/${body.action}`, { method: 'POST', body: { version: body.version, ...(body.payment ? { payment: body.payment } : {}) }, idempotencyKey: key }), { onSuccess: refresh });
  // ADR-0038: an approved dispatch sale goes to the warehouse instead of completing here.
  const send = useOnceCommand((version: number, key) => api<{ orderId: string | null }>(`/sales/${id}/dispatch`, { method: 'POST', body: { version }, idempotencyKey: key }), {
    onSuccess: (r) => { void queryClient.invalidateQueries({ queryKey: keys.sales() }); if (r.orderId) router.push(`/field/orders/${r.orderId}`); },
  });

  if (sale.isPending) return <p className="text-sm text-stone-500">{t('loading')}</p>;
  if (sale.error) return <Alert>{errorText(sale.error)}</Alert>;
  const s = sale.data;
  // ADR-0052: an open sale has no store — it is paid in full as it completes, and never returned.
  const open = s.open !== null;
  const billToBill = s.store?.creditMode === 'BILL_TO_BILL';
  const owed = sumMoney([store.data?.credit.outstanding ?? ('0.00' as Money), s.total]);
  const payment = open ? paymentBody({ ...draft, amount: s.total }, s.total) : paying ? paymentBody(draft, owed) : null;
  const a = s.approval;
  const mustSend = s.sendingMode === 'COMPULSORY' && (s.document?.sends.length ?? 0) === 0 && s.document?.status !== 'FAILED';

  return (
    <div className="space-y-4 pb-6">
      <PageHeader title={partyOf(s, t)} back={{ href: '/field/sales', label: t('mySales') }} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SALE_TONE[s.status]} data-testid="sale-status">{t(`statuses.${s.status}`)}</Badge>
        {s.cancelReason ? <Badge>{t(`cancelReasons.${s.cancelReason}`)}</Badge> : null}
        <span className="text-sm text-stone-600">{format.dateTime(s.completedAt ?? s.createdAt)}</span>
      </div>

      {s.status === 'PENDING_DISCOUNT_APPROVAL' && a ? (
        <Alert tone="warning" data-testid="waiting">
          <div className="font-semibold">{open ? t('open.waitingTitle') : t('waitingTitle')}</div>
          <div>{t('waitingHint', { time: format.dateTime(a.expiresAt) })}</div>
        </Alert>
      ) : null}
      {s.status === 'DISCOUNT_APPROVED' && a ? (
        <Alert tone="success" data-testid="approved">
          <div className="font-semibold">{open ? t('open.approvedTitle') : a.status === 'REDUCED' ? t('reducedTitle') : t('approvedTitle')}</div>
          {a.comment ? <div>{t('decisionComment', { comment: a.comment })}</div> : null}
        </Alert>
      ) : null}
      {s.status === 'CANCELLED' ? (
        <Alert tone={s.cancelReason === 'WITHDRAWN' ? 'info' : 'warning'} data-testid="cancelled">
          <div className="font-semibold">{open && s.cancelReason === 'REJECTED' ? t('open.rejectedTitle') : t(`cancelledTitles.${s.cancelReason ?? 'WITHDRAWN'}`)}</div>
          {a?.comment && s.cancelReason === 'REJECTED' ? <div>{t('decisionComment', { comment: a.comment })}</div> : null}
          <div>{t('released')}</div>
          {s.cancelReason !== 'WITHDRAWN' ? (
            <Link href={s.store ? `/field/sell/${s.store.id}?from=${s.id}` : '/field/sell/open'} className="mt-2 inline-block font-medium underline">
              {s.store ? t('freshSale') : t('open.new')}
            </Link>
          ) : null}
        </Alert>
      ) : null}

      {s.open ? (
        <Card className="space-y-1 p-4 text-sm" data-testid="open-buyer">
          <div className="text-stone-500">{t('open.buyer')}</div>
          <div className="font-medium">{s.open.buyerName ?? t('open.noBuyer')}</div>
          {s.open.buyerPhone ? <div><bdi dir="ltr">{s.open.buyerPhone}</bdi></div> : null}
        </Card>
      ) : null}
      <Card><SaleLinesTable sale={s} /></Card>
      {s.payment ? (
        <p className="text-sm text-stone-600" data-testid="paid">
          {t('paidWith', { method: ts(`methods.${s.payment.method}`), amount: format.money(s.payment.amount) })}
          {s.payment.voucher ? <span className="block" data-testid="paid-voucher">{ts('voucherIs', { number: s.payment.voucher.number })}</span> : null}
        </p>
      ) : null}
      {s.creditOverride ? <p className="text-sm text-stone-600">{t('overrideUsed', { name: s.creditOverride.grantedBy, reason: s.creditOverride.reason })}</p> : null}

      {act.error ? <Alert>{errorText(act.error)}</Alert> : null}
      {send.error ? <Alert>{errorText(send.error)}</Alert> : null}
      {s.dispatchOrder ? <Link href={`/field/orders/${s.dispatchOrder.id}`} className="inline-flex h-11 w-full items-center justify-center rounded-md border border-stone-300 text-sm font-medium" data-testid="to-order">{t('toOrder', { number: s.dispatchOrder.number })}</Link> : null}
      {s.status === 'DISCOUNT_APPROVED' && s.channel === 'DISPATCH' ? (
        <Button block disabled={send.isPending} onClick={() => send.run(s.version)}>{t('sendToWarehouse')}</Button>
      ) : null}
      {s.status === 'DISCOUNT_APPROVED' && s.channel === 'VEHICLE' ? (
        <Card className="space-y-3 p-4">
          {billToBill && store.data ? <p className="text-sm text-stone-600">{t('billToBillNote', { amount: format.money(store.data.credit.available) })}</p> : null}
          {open ? <PaymentFields id="complete" owed={s.total} value={draft} onChange={setDraft} fullAmount={s.total} /> : (
            <>
              <label htmlFor="take-payment" className="flex items-center gap-2 text-sm font-medium">
                <Checkbox id="take-payment" checked={paying} onChange={(e) => setPaying(e.target.checked)} />
                {t('takePayment')}
              </label>
              {paying ? <PaymentFields id="complete" owed={owed} value={draft} onChange={setDraft} /> : null}
            </>
          )}
          <Button block disabled={act.isPending || ((paying || open) && !payment)} onClick={() => act.run({ action: 'complete', version: s.version, payment: payment ?? undefined })}>
            {act.isPending ? t('saving') : t('complete')}
          </Button>
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
          {/* RET-001: returns start from the sale — never an open sale's (SAL-018). */}
          {open ? <p className="text-sm text-stone-500">{t('open.notReturnable')}</p> : <SaleReturns saleId={s.id} surface="field" canReturn={canReturn} />}
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
