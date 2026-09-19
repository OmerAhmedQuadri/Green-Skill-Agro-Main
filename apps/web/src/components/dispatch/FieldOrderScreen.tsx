'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { wholeNumber } from '@/lib/forms';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { OrderLines } from './OrderLines';
import { DISPATCH_TONE, type DispatchOrder } from './types';

type Counts = { received: string; short: string; damaged: string };

/**
 * A dispatch order on the seller's phone (DSP-009..013). Once released, the
 * seller confirms what arrived — line by line, received, short or damaged —
 * and how they know: in person, or on the owner's word. A short delivery is
 * then made good from the vehicle, by a further order, or not at all. If
 * nothing came, the seller claims it lost.
 */
export function FieldOrderScreen({ id }: { id: string }) {
  const t = useTranslations('dispatch');
  const ts = useTranslations('stores');
  const format = useFormat();
  const errorText = useErrorText();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [counts, setCounts] = useState<Record<string, Counts>>({});
  const [mode, setMode] = useState<'IN_PERSON' | 'OWNER_WORD'>('IN_PERSON');
  const [method, setMethod] = useState<'CASH' | 'BANK_TRANSFER'>('CASH');
  const [reference, setReference] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [claimReason, setClaimReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const order = useQuery({
    queryKey: keys.dispatchOrder(id), queryFn: () => api<DispatchOrder>(`/dispatch-orders/${id}`),
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'CLOSED' && q.state.data.status !== 'DELIVERED' ? 15_000 : false),
  });
  const refresh = (o: DispatchOrder) => {
    queryClient.setQueryData(keys.dispatchOrder(id), o);
    for (const k of [keys.sales(), keys.dispatchOrders(), keys.cashInHand, keys.store(o.store.id)]) void queryClient.invalidateQueries({ queryKey: k });
  };
  const act = useOnceCommand((body: { action: string; data: unknown }, key) => api<DispatchOrder>(`/dispatch-orders/${id}/${body.action}`, { method: 'POST', body: body.data, idempotencyKey: key }), {
    onSuccess: (o, { vars }) => {
      refresh(o);
      setClaiming(false);
      setCancelling(false);
      const data = vars.data as { resolution?: string };
      if (vars.action === 'resolve' && data.resolution === 'FROM_VEHICLE') router.push(`/field/sell/${o.store.id}?shortfall=${o.id}`);
      if (vars.action === 'resolve' && data.resolution === 'FURTHER_ORDER') router.push(`/field/order/${o.store.id}?shortfall=${o.id}`);
    },
  });

  if (order.isPending) return <p className="text-sm text-stone-500">{t('loading')}</p>;
  if (order.error) return <Alert>{errorText(order.error)}</Alert>;
  const o = order.data;
  const pendingClaim = o.claims.find((c) => c.status === 'PENDING');
  const countOf = (lineId: string, packs: number): Counts => counts[lineId] ?? { received: String(packs), short: '0', damaged: '0' };
  const set = (lineId: string, packs: number, field: keyof Counts, value: string) => setCounts({ ...counts, [lineId]: { ...countOf(lineId, packs), [field]: value } });
  const billToBill = o.store.creditMode === 'BILL_TO_BILL';

  return (
    <div className="space-y-4 pb-6">
      <PageHeader title={o.store.name} subtitle={<bdi dir="ltr">{o.number}</bdi>} back={{ href: '/field/sales', label: t('mySalesBack') }} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={DISPATCH_TONE[o.status]} data-testid="order-status">{t(`statuses.${o.status}`)}</Badge>
        {o.closeReason ? <Badge>{t(`closeReasons.${o.closeReason}`)}</Badge> : null}
        {o.forSeller ? <Badge tone="warning" data-testid="for-seller">{t('raisedForYou', { name: o.raisedBy.name })}</Badge> : null}
        {o.unconfirmed ? <Badge tone="danger">{t('unconfirmed')}</Badge> : null}
      </div>
      {o.handledBy && (o.status === 'BEING_HANDLED') ? <p className="text-sm text-stone-600">{t('handledBy', { name: o.handledBy.name })}</p> : null}
      {o.status === 'RELEASED' && o.releasedAt ? <Alert tone="info">{t('onItsWay', { time: format.dateTime(o.releasedAt) })}</Alert> : null}
      {pendingClaim ? <Alert tone="warning" data-testid="claim-pending">{t('claimPending')}</Alert> : null}

      <Card><OrderLines order={o} /></Card>

      {act.error ? <Alert>{errorText(act.error)}</Alert> : null}

      {o.status === 'RELEASED' && !pendingClaim ? (
        <Card className="space-y-4 p-4" data-testid="receipt">
          <p className="font-semibold">{t('confirmTitle')}</p>
          {o.lines.map((l) => {
            const c = countOf(l.id, l.packs);
            return (
              <fieldset key={l.id} className="space-y-2" data-testid={`receipt-${l.code}`}>
                <legend className="text-sm font-medium"><bdi dir="ltr">{l.code}</bdi>{` · ${t('released', { count: l.packs })}`}</legend>
                <div className="grid grid-cols-3 gap-2">
                  <Field id={`rc-${l.id}`} label={t('receivedFor', { code: l.code })}><Input id={`rc-${l.id}`} inputMode="numeric" dir="ltr" value={c.received} onChange={(e) => set(l.id, l.packs, 'received', e.target.value)} /></Field>
                  <Field id={`sh-${l.id}`} label={t('shortFor', { code: l.code })}><Input id={`sh-${l.id}`} inputMode="numeric" dir="ltr" value={c.short} onChange={(e) => set(l.id, l.packs, 'short', e.target.value)} /></Field>
                  <Field id={`dm-${l.id}`} label={t('damagedFor', { code: l.code })}><Input id={`dm-${l.id}`} inputMode="numeric" dir="ltr" value={c.damaged} onChange={(e) => set(l.id, l.packs, 'damaged', e.target.value)} /></Field>
                </div>
              </fieldset>
            );
          })}
          <Field id="mode" label={t('howConfirmed')}>
            <Select id="mode" value={mode} onChange={(e) => setMode(e.target.value === 'OWNER_WORD' ? 'OWNER_WORD' : 'IN_PERSON')}>
              <option value="IN_PERSON">{t('modes.IN_PERSON')}</option><option value="OWNER_WORD">{t('modes.OWNER_WORD')}</option>
            </Select>
          </Field>
          {mode === 'OWNER_WORD' ? <p className="text-sm text-stone-600">{t('ownerWordNote')}</p> : null}
          {billToBill ? (
            <>
              <Field id="method" label={ts('method')}>
                <Select id="method" value={method} onChange={(e) => setMethod(e.target.value === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH')}>
                  <option value="CASH">{ts('methods.CASH')}</option><option value="BANK_TRANSFER">{ts('methods.BANK_TRANSFER')}</option>
                </Select>
              </Field>
              {method === 'BANK_TRANSFER' ? <Field id="reference" label={ts('reference')}><Input id="reference" dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} /></Field> : null}
            </>
          ) : null}
          <Button block disabled={act.isPending} onClick={() => act.run({
            action: 'confirm-receipt', data: {
              version: o.version, mode,
              lines: o.lines.map((l) => {
                const c = countOf(l.id, l.packs);
                return { lineId: l.id, received: wholeNumber(c.received) ?? -1, short: wholeNumber(c.short) ?? -1, damaged: wholeNumber(c.damaged) ?? -1 };
              }),
              payment: billToBill ? { method, reference: method === 'BANK_TRANSFER' ? reference.trim() || null : null } : null,
            },
          })}>{t('confirmReceipt')}</Button>
          {claiming ? (
            <div className="space-y-2 border-t border-stone-200 pt-3">
              <Field id="claim" label={t('claimReason')}><Input id="claim" value={claimReason} maxLength={500} onChange={(e) => setClaimReason(e.target.value)} /></Field>
              <div className="flex gap-2">
                <Button variant="danger" disabled={act.isPending || !claimReason.trim()} onClick={() => act.run({ action: 'lost-claim', data: { version: o.version, reason: claimReason.trim() } })}>{t('claimLost')}</Button>
                <Button variant="ghost" onClick={() => setClaiming(false)}>{t('cancel')}</Button>
              </div>
            </div>
          ) : <Button variant="ghost" block onClick={() => setClaiming(true)}>{t('nothingArrived')}</Button>}
        </Card>
      ) : null}

      {o.status === 'DELIVERED' ? (
        <Card className="space-y-3 p-4" data-testid="resolve">
          <p className="font-semibold">{t('shortfallTitle')}</p>
          <p className="text-sm text-stone-600">{t('shortfallHint')}</p>
          <div className="grid gap-2">
            <Button onClick={() => act.run({ action: 'resolve', data: { version: o.version, resolution: 'FROM_VEHICLE' } })} disabled={act.isPending}>{t('resolutions.FROM_VEHICLE')}</Button>
            <Button variant="secondary" onClick={() => act.run({ action: 'resolve', data: { version: o.version, resolution: 'FURTHER_ORDER' } })} disabled={act.isPending}>{t('resolutions.FURTHER_ORDER')}</Button>
            <Button variant="ghost" onClick={() => act.run({ action: 'resolve', data: { version: o.version, resolution: 'NOT_NEEDED' } })} disabled={act.isPending}>{t('resolutions.NOT_NEEDED')}</Button>
          </div>
        </Card>
      ) : null}

      {o.status === 'REQUESTED' || o.status === 'BEING_HANDLED' ? (
        cancelling ? (
          <Card className="space-y-2 p-4">
            <Field id="cancel-reason" label={t('cancelReason')}><Input id="cancel-reason" value={cancelReason} maxLength={500} onChange={(e) => setCancelReason(e.target.value)} /></Field>
            <div className="flex gap-2">
              <Button variant="danger" disabled={act.isPending || !cancelReason.trim()} onClick={() => act.run({ action: 'cancel', data: { version: o.version, reason: cancelReason.trim() } })}>{t('cancelOrder')}</Button>
              <Button variant="ghost" onClick={() => setCancelling(false)}>{t('keep')}</Button>
            </div>
          </Card>
        ) : <Button variant="ghost" block onClick={() => setCancelling(true)}>{t('cancelOrder')}</Button>
      ) : null}

      {o.sale.status === 'COMPLETED' ? (
        <Link href={`/field/sales/${o.sale.id}`} className="inline-flex h-11 w-full items-center justify-center rounded-md border border-stone-300 text-sm font-medium" data-testid="to-sale">{t('toSaleDocument')}</Link>
      ) : null}
    </div>
  );
}
