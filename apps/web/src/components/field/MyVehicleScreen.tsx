'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Field, Input } from '@gsa/ui';
import { ConvertPanel } from '@/components/warehouse/ConvertPanel';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { FieldWriteOff } from './FieldWriteOff';
import type { Handover, Load, MyVehicle, MyVehicleBatch } from './types';

/**
 * The seller's vehicle (STK-006, EXP-007, VEH-007, VEH-009): loads to
 * confirm or dispute, a handover to confirm, and the stock on board — each
 * batch with its expiry indicator, and the actions allowed on it.
 */
export function MyVehicleScreen({ userId, canWriteOff, canConvert }: { userId: string; canWriteOff: boolean; canConvert: boolean }) {
  const t = useTranslations('field');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [acting, setActing] = useState<{ batchId: string; action: 'writeOff' | 'convert' } | null>(null);
  const [disputing, setDisputing] = useState<string | null>(null);
  const vehicle = useQuery({ queryKey: keys.myVehicle, queryFn: () => api<MyVehicle>('/stock/my-vehicle') });
  const loads = useQuery({ queryKey: keys.loads({ mine: true }), queryFn: () => api<Load[]>('/vehicle-loads?open=true') });
  const handovers = useQuery({ queryKey: keys.handovers, queryFn: () => api<Handover[]>('/vehicle-handovers') });
  const refresh = () => {
    for (const key of [keys.myVehicle, keys.loads(), keys.handovers, keys.today]) void queryClient.invalidateQueries({ queryKey: key });
  };
  const loadCmd = useCommand(({ id, action, body }: { id: string; action: 'confirm' | 'dispute'; body: object }, key) =>
    api<Load>(`/vehicle-loads/${id}/${action}`, { method: 'POST', body, idempotencyKey: key }), { onSuccess: () => { setDisputing(null); refresh(); } });
  const handoverCmd = useCommand((id: string, key) => api<Handover>(`/vehicle-handovers/${id}/confirm`, { method: 'POST', body: {}, idempotencyKey: key }), { onSuccess: refresh });

  const dispute = (l: Load) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    loadCmd.run({ id: l.id, action: 'dispute', body: { version: l.version, comment: formText(new FormData(e.currentTarget), 'comment') } });
  };
  const indicator = (b: MyVehicleBatch) => {
    if (!b.expiry.flagged) return null;
    if (b.expiry.prioritised) return t('indicator.prioritised');
    if (b.expiry.time) return b.expiry.daysLeft !== null && b.expiry.daysLeft < 0 ? t('indicator.expired') : t('indicator.expiring', { days: b.expiry.daysLeft ?? 0 });
    return b.expiry.rate?.reason === 'NO_RECENT_SALES' ? t('indicator.notMoving') : t('indicator.slow');
  };

  const openLoads = loads.data ?? [];
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{vehicle.data?.vehicle ? <bdi dir="ltr">{vehicle.data.vehicle.registration}</bdi> : t('yourVehicle')}</h1>
      {vehicle.error ? <Alert>{errorText(vehicle.error)}</Alert> : null}
      {loadCmd.error ? <Alert>{errorText(loadCmd.error)}</Alert> : null}
      {handoverCmd.error ? <Alert>{errorText(handoverCmd.error)}</Alert> : null}

      {openLoads.map((l) => (
        <Card key={l.id} className="space-y-3 p-4" data-testid={`load-${l.number}`}>
          <div className="flex items-center justify-between">
            <span className="font-semibold">{t('loadTitle', { number: l.number })}</span>
            <Badge tone={l.status === 'ISSUED' ? 'warning' : 'neutral'}>{t(`loadStatus.${l.status}`)}</Badge>
          </div>
          <ul className="divide-y divide-stone-100 text-sm">
            {l.lines.map((line) => (
              <li key={line.batchId} className="flex justify-between py-1.5">
                <span><bdi dir="ltr" className="font-mono">{line.code}</bdi>{' · '}<bdi dir="ltr">{line.lotNumber ?? '—'}</bdi></span>
                <span className="font-medium">{t('packs', { count: line.packs })}</span>
              </li>
            ))}
          </ul>
          {l.status === 'DISPUTED' ? <Alert tone="info">{t('disputedWaiting', { comment: l.disputeComment ?? '' })}</Alert> : null}
          {l.status === 'ISSUED' && disputing !== l.id ? (
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => loadCmd.run({ id: l.id, action: 'confirm', body: { version: l.version } })} disabled={loadCmd.isPending}>{t('confirmLoad')}</Button>
              <Button variant="secondary" onClick={() => setDisputing(l.id)}>{t('disputeLoad')}</Button>
            </div>
          ) : null}
          {disputing === l.id ? (
            <form className="space-y-2" noValidate onSubmit={dispute(l)}>
              <Field id={`dispute-${l.id}`} label={t('disputeComment')}><Input id={`dispute-${l.id}`} name="comment" maxLength={500} required /></Field>
              <div className="flex gap-2">
                <Button type="submit" disabled={loadCmd.isPending}>{t('sendDispute')}</Button>
                <Button variant="ghost" onClick={() => setDisputing(null)}>{t('cancel')}</Button>
              </div>
            </form>
          ) : null}
        </Card>
      ))}

      {(handovers.data ?? []).map((h) => {
        const mine = h.outgoing.id === userId ? h.outgoing : h.incoming;
        return (
          <Card key={h.id} className="space-y-2 p-4" data-testid="handover">
            <p className="font-semibold">{t('handoverTitle', { registration: h.registration })}</p>
            <p className="text-sm">{t('handoverParties', { from: h.outgoing.name, to: h.incoming.name })}</p>
            {mine.confirmedAt
              ? <p className="text-sm text-stone-600">{t('handoverWaitingOther')}</p>
              : <Button onClick={() => handoverCmd.run(h.id)} disabled={handoverCmd.isPending}>{t('confirmHandover')}</Button>}
          </Card>
        );
      })}

      <Card>
        <div className="flex items-center justify-between border-b border-stone-200 p-4">
          <span className="font-semibold">{t('stockOnBoard')}</span>
          {vehicle.data ? <span className="text-sm text-stone-600">{t('vehicleStock', { packs: format.number(vehicle.data.packs), value: format.money(vehicle.data.value) })}</span> : null}
        </div>
        {vehicle.data && vehicle.data.batches.length === 0 ? <p className="p-4 text-sm text-stone-500">{vehicle.data.vehicle ? t('emptyVehicle') : t('noVehicle')}</p> : null}
        <ul className="divide-y divide-stone-100">
          {(vehicle.data?.batches ?? []).map((b) => (
            <li key={b.batchId} data-testid={`batch-${b.lotNumber ?? b.batchId}`}>
              <div className="space-y-1.5 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <bdi dir="ltr" className="font-mono text-sm font-medium">{b.code}</bdi>
                    <div className="text-sm text-stone-600">{format.name(b.product)}</div>
                  </div>
                  <div className="text-end">
                    <div className="font-semibold">{t('packs', { count: b.packs })}</div>
                    {b.heldPacks > 0 ? <div className="text-xs text-amber-800">{t('heldPacks', { count: b.heldPacks })}</div> : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
                  <span>{t('lot')}{' '}<bdi dir="ltr">{b.lotNumber ?? '—'}</bdi></span>
                  {b.expiresOn ? <span>{t('expires', { date: format.date(b.expiresOn) })}</span> : null}
                  {indicator(b) ? <Badge tone="warning" data-testid="expiry-indicator">{indicator(b)}</Badge> : null}
                </div>
                {(canWriteOff || canConvert) && acting?.batchId !== b.batchId ? (
                  <div className="flex gap-2 pt-1">
                    {canWriteOff ? <Button size="sm" variant="secondary" onClick={() => setActing({ batchId: b.batchId, action: 'writeOff' })}>{t('writeOff')}</Button> : null}
                    {canConvert ? <Button size="sm" variant="secondary" onClick={() => setActing({ batchId: b.batchId, action: 'convert' })}>{t('convert')}</Button> : null}
                  </div>
                ) : null}
              </div>
              {acting?.batchId === b.batchId && acting.action === 'writeOff' ? <FieldWriteOff batch={b} onDone={() => { setActing(null); refresh(); }} /> : null}
              {acting?.batchId === b.batchId && acting.action === 'convert' ? (
                <div className="border-t border-stone-200">
                  <ConvertPanel sku={b} batch={b} held={b.packs - b.heldPacks} canPrice={false} onDone={() => { setActing(null); refresh(); }} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
