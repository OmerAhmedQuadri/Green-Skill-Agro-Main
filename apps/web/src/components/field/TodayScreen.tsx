'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, Coffee, LogIn, LogOut, PackageCheck, Truck } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card } from '@gsa/ui';
import { api } from '@/lib/api';
import { useDuration } from '@/lib/duration';
import { useFormat } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { CaptureForm } from './CaptureForm';
import type { Handover, Load, MyVehicle, Today } from './types';

/**
 * The seller's home (workflow G, EXP-007): the day — checked in or not, on a
 * break, hours so far — and the vehicle: its stock, items flagged near expiry,
 * and anything waiting for the seller to confirm.
 */
export function TodayScreen({ name }: { name: string }) {
  const t = useTranslations('field');
  const format = useFormat();
  const duration = useDuration();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [capturing, setCapturing] = useState<'in' | 'out' | null>(null);
  const today = useQuery({ queryKey: keys.today, queryFn: () => api<Today>('/attendance/today'), refetchInterval: 60_000 });
  const vehicle = useQuery({ queryKey: keys.myVehicle, queryFn: () => api<MyVehicle>('/stock/my-vehicle') });
  const loads = useQuery({ queryKey: keys.loads({ status: 'ISSUED' }), queryFn: () => api<Load[]>('/vehicle-loads?status=ISSUED') });
  const handovers = useQuery({ queryKey: keys.handovers, queryFn: () => api<Handover[]>('/vehicle-handovers') });
  const breakCmd = useCommand((action: 'start' | 'end', key) => api<Today>(`/attendance/breaks/${action}`, { method: 'POST', body: {}, idempotencyKey: key }),
    { onSuccess: (d) => queryClient.setQueryData(keys.today, d) });

  const done = (d: Today) => {
    queryClient.setQueryData(keys.today, d);
    setCapturing(null);
    void queryClient.invalidateQueries({ queryKey: keys.myVehicle });
  };

  if (today.isPending) return <p className="text-sm text-stone-500">{t('loading')}</p>;
  if (today.error) return <Alert>{errorText(today.error)}</Alert>;
  const d = today.data;
  if (capturing) return <CaptureForm mode={capturing} today={d} onDone={done} onCancel={() => setCapturing(null)} />;

  const live = d.live;
  const status = live?.status === 'AWAITING_AUTHORISATION' ? 'AWAITING' : d.day?.status ?? 'NONE';
  const waitingLoads = loads.data?.length ?? 0;
  const waitingHandovers = (handovers.data ?? []).length;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('welcome', { name })}</h1>

      <Card className="space-y-3 p-4" data-testid="day-card">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-stone-600">{t('yourDay')}</span>
          <Badge tone={status === 'OPEN' ? 'success' : status === 'ON_BREAK' || status === 'AWAITING' ? 'warning' : 'neutral'}>{t(`status.${status}`)}</Badge>
        </div>
        {breakCmd.error ? <Alert>{errorText(breakCmd.error)}</Alert> : null}

        {status === 'OPEN' && live ? (
          <>
            <p className="text-sm">{t('workingSince', { time: format.dateTime(live.checkedInAt) })}</p>
            <p className="text-2xl font-semibold" data-testid="active-hours">{duration(d.totals.activeMs)}</p>
            {d.day?.vehicle ? <p className="text-sm text-stone-600">{t('withVehicle', { registration: d.day.vehicle.registration })}</p> : <p className="text-sm text-stone-600">{t('noVehicleToday')}</p>}
            {live.openedOnBehalf ? <Alert tone="info">{t('openedOnBehalf', { reason: live.onBehalfReason ?? '' })}</Alert> : null}
            <div className="grid gap-2">
              {d.breaksEnabled ? <Button variant="secondary" onClick={() => breakCmd.run('start')} disabled={breakCmd.isPending}><Coffee className="size-4" aria-hidden />{t('startBreak')}</Button> : null}
              {d.day?.vehicle ? (
                d.closingDeclared
                  ? <p className="text-sm text-brand-800"><PackageCheck className="me-1 inline size-4" aria-hidden />{t('closingDeclared')}</p>
                  : <Link href="/field/closing" className="inline-flex h-11 items-center justify-center rounded-md border border-stone-300 px-4 text-sm font-medium hover:bg-stone-50">{t('declareClosing')}</Link>
              ) : null}
              <Button onClick={() => setCapturing('out')}><LogOut className="size-4" aria-hidden />{t('checkOut')}</Button>
            </div>
          </>
        ) : null}

        {status === 'ON_BREAK' ? (
          <>
            <p className="text-sm">{t('onBreakSince', { time: format.dateTime(live?.breaks.at(-1)?.startedAt ?? new Date()) })}</p>
            <Button onClick={() => breakCmd.run('end')} disabled={breakCmd.isPending}>{t('endBreak')}</Button>
          </>
        ) : null}

        {status === 'AWAITING' ? (
          <>
            <Alert tone="warning">{t('awaitingAuthorisation')}</Alert>
            <Button variant="secondary" onClick={() => setCapturing('in')}>{t('tryAgain')}</Button>
          </>
        ) : null}

        {status === 'NONE' || status === 'CHECKED_OUT' || status === 'CLOSED' ? (
          <>
            {d.sessions.length > 0 ? (
              <div className="space-y-1 text-sm" data-testid="day-summary">
                <p>{t('dayTotals', { hours: duration(d.totals.activeMs), km: d.totals.distanceKm === null ? '—' : format.number(d.totals.distanceKm) })}</p>
                {d.sessions.map((s) => (
                  <p key={s.id} className="text-stone-600">
                    {`${format.dateTime(s.checkedInAt)} – ${s.checkedOutAt ? format.dateTime(s.checkedOutAt) : '…'}`}
                    {s.flags.length > 0 ? <Badge tone="warning" className="ms-2">{t('odometerFlagged')}</Badge> : null}
                  </p>
                ))}
              </div>
            ) : <p className="text-sm text-stone-600">{t('notCheckedIn')}</p>}
            <Button onClick={() => setCapturing('in')}><LogIn className="size-4" aria-hidden />{d.sessions.length > 0 ? t('checkInAgain') : t('checkIn')}</Button>
          </>
        ) : null}
      </Card>

      {waitingLoads + waitingHandovers > 0 ? (
        <Link href="/field/vehicle" className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle className="size-5 shrink-0" aria-hidden />
          <span className="flex-1">{t('waiting', { loads: waitingLoads, handovers: waitingHandovers })}</span>
          <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />
        </Link>
      ) : null}

      <Link href="/field/vehicle" className="block">
        <Card className="space-y-2 p-4" data-testid="vehicle-card">
          <div className="flex items-center gap-2 text-sm font-medium text-stone-600"><Truck className="size-4" aria-hidden />{t('yourVehicle')}</div>
          {vehicle.data?.vehicle ? (
            <>
              <p className="text-lg font-semibold"><bdi dir="ltr">{vehicle.data.vehicle.registration}</bdi></p>
              <p className="text-sm">{t('vehicleStock', { packs: format.number(vehicle.data.packs), value: format.money(vehicle.data.value) })}</p>
              {vehicle.data.flaggedCount > 0 ? <Badge tone="warning" data-testid="flagged-items">{t('flaggedItems', { count: vehicle.data.flaggedCount })}</Badge> : null}
            </>
          ) : <p className="text-sm text-stone-600">{t('noVehicle')}</p>}
        </Card>
      </Link>
    </div>
  );
}
