'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Field, Input } from '@gsa/ui';
import { EvidenceUpload } from '@/components/common/EvidenceUpload';
import { PageHeader } from '@/components/common/PageHeader';
import { Facts, Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { OrderLines } from './OrderLines';
import { DISPATCH_TONE, type DispatchOrder } from './types';

type Can = { fulfil: boolean; decideClaims: boolean; me: string };

/**
 * A dispatch order in the console (DSP-004..008, DSP-013). Taking it puts
 * your name on it — a label others see, not a lock. Release needs the
 * transport slip; the stock is taken from the warehouse then, soonest expiry
 * first. A lost-order claim is decided here.
 */
export function DispatchDetail({ id, can }: { id: string; can: Can }) {
  const t = useTranslations('dispatch');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [slipId, setSlipId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [claimComment, setClaimComment] = useState('');
  const order = useQuery({ queryKey: keys.dispatchOrder(id), queryFn: () => api<DispatchOrder>(`/dispatch-orders/${id}`) });
  const act = useCommand((body: { action: string; data: unknown }, key) => api<DispatchOrder>(`/dispatch-orders/${id}/${body.action}`, { method: 'POST', body: body.data, idempotencyKey: key }), {
    onSuccess: (o) => { queryClient.setQueryData(keys.dispatchOrder(id), o); void queryClient.invalidateQueries({ queryKey: keys.dispatchOrders() }); },
    onError: () => { void queryClient.invalidateQueries({ queryKey: keys.dispatchOrder(id) }); },
  });

  if (order.isPending) return <p className="text-sm text-stone-500">{t('loading')}</p>;
  if (order.error) return <Alert>{errorText(order.error)}</Alert>;
  const o = order.data;
  const waiting = o.status === 'REQUESTED' || o.status === 'BEING_HANDLED';
  const someoneElse = o.handledBy && o.handledBy.id !== can.me;
  const pendingClaim = o.claims.find((c) => c.status === 'PENDING');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={<bdi dir="ltr">{o.number}</bdi>} subtitle={`${o.store.name} · ${o.seller.name}`} back={{ href: '/console/dispatch', label: t('title') }}
        actions={<Badge tone={DISPATCH_TONE[o.status]} data-testid="order-status">{t(`statuses.${o.status}`)}</Badge>} />
      {o.forSeller ? <Alert tone="info">{t('raisedByLine', { name: o.raisedBy.name })}</Alert> : null}
      {o.unconfirmed ? <Alert tone="warning">{t('unconfirmedNote')}</Alert> : null}
      {act.error ? <Alert>{errorText(act.error)}</Alert> : null}

      {can.fulfil && waiting ? (
        <Section title={t('handling')}>
          <div className="space-y-4 p-5">
            <p className="text-sm" data-testid="handled-by">{o.handledBy ? t('handledBy', { name: o.handledBy.name }) : t('nobodyHandling')}</p>
            {someoneElse ? <Alert tone="warning">{t('someoneElse', { name: o.handledBy?.name ?? '' })}</Alert> : null}
            <div className="flex flex-wrap gap-2">
              {o.handledBy?.id !== can.me ? <Button variant="secondary" onClick={() => act.run({ action: 'take', data: { version: o.version } })} disabled={act.isPending}>{someoneElse ? t('takeOver') : t('take')}</Button> : null}
              {o.handledBy ? <Button variant="ghost" onClick={() => act.run({ action: 'release-back', data: { version: o.version } })} disabled={act.isPending}>{t('handBack')}</Button> : null}
            </div>
            <div className="space-y-3 border-t border-stone-200 pt-4">
              <p className="font-semibold">{t('releaseTitle')}</p>
              <p className="text-sm text-stone-600">{t('releaseHint')}</p>
              <EvidenceUpload id="slip" kind="TRANSPORT_SLIP" label={t('transportSlip')} onChange={setSlipId} />
              <Field id="note" label={t('transportNote')}><Input id="note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
              <Button disabled={!slipId || act.isPending} onClick={() => act.run({ action: 'release', data: { version: o.version, transportSlipPhotoId: slipId, transportNote: note.trim() || null } })}>{t('release')}</Button>
            </div>
            <div className="flex flex-wrap items-end gap-2 border-t border-stone-200 pt-4">
              <Field id="cancel-reason" label={t('cancelReason')}><Input id="cancel-reason" value={cancelReason} maxLength={500} onChange={(e) => setCancelReason(e.target.value)} /></Field>
              <Button variant="danger" disabled={!cancelReason.trim() || act.isPending} onClick={() => act.run({ action: 'cancel', data: { version: o.version, reason: cancelReason.trim() } })}>{t('cancelOrder')}</Button>
            </div>
          </div>
        </Section>
      ) : null}

      {pendingClaim && can.decideClaims ? (
        <Section title={t('claimTitle')}>
          <div className="space-y-3 p-5" data-testid="claim-decision">
            <p className="text-sm">{t('claimBy', { name: pendingClaim.raisedBy.name, time: format.dateTime(pendingClaim.raisedAt) })}</p>
            <p className="text-sm font-medium">{pendingClaim.reason}</p>
            <Field id="claim-comment" label={t('comment')}><Input id="claim-comment" value={claimComment} maxLength={500} onChange={(e) => setClaimComment(e.target.value)} /></Field>
            <div className="flex gap-2">
              <Button variant="danger" disabled={act.isPending} onClick={() => act.run({ action: 'decide-claim', data: { version: o.version, approve: true, comment: claimComment.trim() || null } })}>{t('approveClaim')}</Button>
              <Button variant="secondary" disabled={act.isPending || !claimComment.trim()} onClick={() => act.run({ action: 'decide-claim', data: { version: o.version, approve: false, comment: claimComment.trim() } })}>{t('rejectClaim')}</Button>
            </div>
          </div>
        </Section>
      ) : null}

      <Section title={t('lines')}><OrderLines order={o} showBatches /></Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t('details')}>
          <Facts items={[
            { label: t('raisedBy'), value: `${o.raisedBy.name} · ${format.dateTime(o.createdAt)}` },
            { label: t('releasedLabel'), value: o.releasedAt ? `${o.releasedBy?.name ?? ''} · ${format.dateTime(o.releasedAt)}` : '—' },
            { label: t('transportSlip'), value: o.transportSlipMediaId ? <a className="text-brand-800 hover:underline" target="_blank" rel="noreferrer" href={`/api/v1/media/${o.transportSlipMediaId}`}>{t('viewSlip')}</a> : '—' },
            { label: t('transportNote'), value: o.transportNote ?? '—' },
            { label: t('confirmedLabel'), value: o.confirmedAt ? `${format.dateTime(o.confirmedAt)} · ${o.confirmationMode ? t(`modes.${o.confirmationMode}`) : ''}` : '—' },
            { label: t('outcome'), value: o.closeReason ? `${t(`closeReasons.${o.closeReason}`)}${o.resolution ? ` · ${t(`resolutions.${o.resolution}`)}` : ''}${o.cancelReason ? ` · ${o.cancelReason}` : ''}` : '—' },
          ]} />
        </Section>
        <Section title={t('history')}>
          <ul className="space-y-2 p-5 text-sm" data-testid="history">
            {o.events.map((e, i) => (
              <li key={i}><span className="text-stone-500">{format.dateTime(e.occurredAt)}</span>{` · ${t(`events.${e.type}`, { name: e.actor ?? '' })}${e.note ? ` — ${e.note}` : ''}`}</li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
