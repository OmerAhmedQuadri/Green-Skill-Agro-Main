'use client';

import { MapPin } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Checkbox, Field, Input } from '@gsa/ui';
import { PhotoCapture } from '@/components/common/PhotoCapture';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { currentPosition, type Position } from '@/lib/geo';
import { latinDigits } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import type { Today } from './types';

/**
 * Workflow G steps 1 and 7 (ATT-001): selfie from the live camera, location
 * found automatically, and — with a vehicle — the odometer photographed and
 * typed in. Location is read once, now, and never watched (ATT-013).
 */
export function CaptureForm({ mode, today, onDone, onCancel }: {
  mode: 'in' | 'out'; today: Today; onDone: (today: Today) => void; onCancel: () => void;
}) {
  const t = useTranslations('field');
  const format = useFormat();
  const errorText = useErrorText();
  const [position, setPosition] = useState<Position | null>(null);
  const [locating, setLocating] = useState(true);
  const [locationError, setLocationError] = useState<unknown>(null);
  const [withoutVehicle, setWithoutVehicle] = useState(false);
  const [selfieId, setSelfieId] = useState<string | null>(null);
  const [odometerPhotoId, setOdometerPhotoId] = useState<string | null>(null);
  const [reading, setReading] = useState('');

  const request = useCallback(() => currentPosition().then(setPosition, setLocationError).finally(() => setLocating(false)), []);
  useEffect(() => { void request(); }, [request]);
  const locate = () => {
    setLocating(true);
    setLocationError(null);
    void request();
  };

  const vehicle = mode === 'in' ? (withoutVehicle ? null : today.assignedVehicle) : today.day?.vehicle ?? null;
  const lastOdometer = mode === 'in' ? today.assignedVehicle?.lastOdometer ?? null : today.live?.checkInOdometer ?? today.assignedVehicle?.lastOdometer ?? null;
  const send = useCommand((body: unknown, key) => api<Today>(`/attendance/${mode === 'in' ? 'check-in' : 'check-out'}`, { method: 'POST', body, idempotencyKey: key }), { onSuccess: onDone });
  const odometerOk = !vehicle || (odometerPhotoId !== null && /^\d{1,7}$/.test(reading));
  const ready = position !== null && selfieId !== null && odometerOk;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!position || !selfieId) return;
    send.run({
      location: position, selfieId, ...(mode === 'in' ? { withoutVehicle } : {}),
      ...(vehicle ? { odometer: Number.parseInt(reading, 10), odometerPhotoId } : {}),
    });
  };
  const capture = position ? { location: position } : {};

  return (
    <form className="space-y-5" noValidate onSubmit={submit} aria-label={mode === 'in' ? t('checkIn') : t('checkOut')}>
      <h2 className="text-lg font-semibold">{mode === 'in' ? t('checkIn') : t('checkOut')}</h2>
      {send.error ? <Alert>{errorText(send.error)}</Alert> : null}

      <div className="flex items-start gap-2 rounded-md bg-stone-50 p-3 text-sm" data-testid="location">
        <MapPin className="mt-0.5 size-4 shrink-0 text-brand-800" aria-hidden />
        {locating ? <span>{t('locating')}</span> : position
          ? <span>{t('locationFound', { accuracy: format.number(position.accuracyM) })}</span>
          : (
            <div className="space-y-2">
              <span className="text-red-800">{errorText(locationError)}</span>
              <Button size="sm" variant="secondary" onClick={locate}>{t('locateAgain')}</Button>
            </div>
          )}
      </div>

      {mode === 'in' && today.assignedVehicle ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={withoutVehicle} onChange={(e) => setWithoutVehicle(e.target.checked)} />
          {t('withoutVehicle', { registration: today.assignedVehicle.registration })}
        </label>
      ) : null}

      <PhotoCapture id={`${mode}-selfie`} kind="SELFIE" label={t('selfie')} capture={capture} onChange={setSelfieId} />

      {vehicle ? (
        <div className="space-y-4">
          <PhotoCapture id={`${mode}-odometer`} kind="ODOMETER" label={t('odometerPhoto')} capture={capture} onChange={setOdometerPhotoId} />
          <Field id={`${mode}-reading`} label={t('odometerReading')}
            hint={lastOdometer !== null ? t('lastReading', { km: format.number(lastOdometer) }) : undefined}>
            <Input id={`${mode}-reading`} value={reading} onChange={(e) => setReading(latinDigits(e.target.value).replace(/\D/g, ''))} inputMode="numeric" dir="ltr" autoComplete="off" />
          </Field>
        </div>
      ) : <p className="text-sm text-stone-600">{t('noOdometer')}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={!ready || send.isPending} block>{send.isPending ? t('sending') : mode === 'in' ? t('checkIn') : t('checkOut')}</Button>
        <Button variant="ghost" onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </form>
  );
}
