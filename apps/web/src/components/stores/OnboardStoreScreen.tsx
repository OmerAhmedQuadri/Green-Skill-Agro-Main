'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { PhotoCapture } from '@/components/common/PhotoCapture';
import { api, ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { decimalText, formText, wholeNumber } from '@/lib/forms';
import { currentPosition, type Position } from '@/lib/geo';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { DuplicateMatch, Store, StoreOptions } from './types';

/**
 * Workflow H (STO-001..008): who and where the store is, a photo of its front
 * taken now, the location found automatically, the optional registrations,
 * and terms from what the Admin offers. A store that looks like one already
 * registered is shown first, and the seller confirms it is different.
 */
export function OnboardStoreScreen() {
  const t = useTranslations('stores');
  const format = useFormat();
  const errorText = useErrorText();
  const router = useRouter();
  const queryClient = useQueryClient();
  const options = useQuery({ queryKey: keys.storeOptions, queryFn: () => api<StoreOptions>('/stores/options') });
  const [position, setPosition] = useState<Position | null>(null);
  const [locating, setLocating] = useState(true);
  const [locationError, setLocationError] = useState<unknown>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [mode, setMode] = useState('');
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);

  const request = useCallback(() => currentPosition().then(setPosition, setLocationError).finally(() => setLocating(false)), []);
  useEffect(() => { void request(); }, [request]);
  const locate = () => { setLocating(true); setLocationError(null); void request(); };

  const onboard = useCommand((body: Record<string, unknown>, key) => api<Store>('/stores', { method: 'POST', body, idempotencyKey: key }), {
    onSuccess: (s) => { void queryClient.invalidateQueries({ queryKey: keys.stores() }); router.push(`/field/stores/${s.id}`); },
  });
  const duplicates = onboard.error instanceof ApiError && onboard.error.code === 'DUPLICATE_STORE_WARNING'
    ? (onboard.error.details?.duplicates as DuplicateMatch[] | undefined) ?? [] : null;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!position || !photoId) return;
    const f = new FormData(e.currentTarget);
    const body = {
      name: formText(f, 'name'), ownerName: formText(f, 'ownerName'), contactNumber: formText(f, 'contactNumber'),
      category: formText(f, 'category') || null, address: formText(f, 'address') || null,
      crNumber: formText(f, 'crNumber') || null, vatNumber: formText(f, 'vatNumber') || null, nationalAddress: formText(f, 'nationalAddress') || null,
      location: position, storefrontPhotoId: photoId,
      creditMode: formText(f, 'creditMode'), creditCycleDays: mode === 'CUSTOM' ? wholeNumber(formText(f, 'creditCycleDays')) : null,
      creditLimit: decimalText(formText(f, 'creditLimit')) || '0', priceListId: formText(f, 'priceListId'),
    };
    setPending(body);
    onboard.run(body);
  };
  const ready = position !== null && photoId !== null;

  return (
    <div className="space-y-4">
      <PageHeader title={t('onboardTitle')} back={{ href: '/field/stores', label: t('myStores') }} />
      {options.data?.approvalRequired ? <Alert tone="info">{t('approvalNote')}</Alert> : null}
      <form className="space-y-5" noValidate onSubmit={submit}>
        {duplicates ? (
          <Card className="space-y-3 border-amber-300 bg-amber-50 p-4" data-testid="duplicate-warning">
            <p className="font-semibold text-amber-900">{t('duplicateTitle')}</p>
            <ul className="space-y-1 text-sm">
              {duplicates.map((d) => (
                <li key={d.storeId}>{t('duplicateLine', { name: d.name, distance: format.number(d.distanceM), similarity: d.similarityPercent })}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button onClick={() => pending && onboard.run({ ...pending, acknowledgeDuplicates: true })} disabled={onboard.isPending}>{t('notDuplicate')}</Button>
              <Button variant="ghost" onClick={() => router.push('/field/stores')}>{t('cancel')}</Button>
            </div>
          </Card>
        ) : onboard.error ? <Alert>{errorText(onboard.error)}</Alert> : null}

        <section className="space-y-3">
          <h2 className="font-semibold">{t('identity')}</h2>
          <Field id="st-name" label={t('name')}><Input id="st-name" name="name" maxLength={160} required /></Field>
          <Field id="st-owner" label={t('ownerName')}><Input id="st-owner" name="ownerName" maxLength={160} required /></Field>
          <Field id="st-contact" label={t('contactNumber')}><Input id="st-contact" name="contactNumber" inputMode="tel" dir="ltr" maxLength={30} required /></Field>
          <Field id="st-category" label={t('category')}><Input id="st-category" name="category" maxLength={80} /></Field>
        </section>

        <section className="space-y-3">
          <h2 className="font-semibold">{t('whereTitle')}</h2>
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
          <Field id="st-address" label={t('address')}><Input id="st-address" name="address" maxLength={300} /></Field>
          <PhotoCapture id="st-photo" kind="STOREFRONT" label={t('storefront')} capture={position ? { location: position } : {}} onChange={setPhotoId} />
        </section>

        <section className="space-y-3">
          <h2 className="font-semibold">{t('registrations')}</h2>
          <Field id="st-cr" label={t('crNumber')} hint={t('optional')}><Input id="st-cr" name="crNumber" dir="ltr" maxLength={40} /></Field>
          <Field id="st-vat" label={t('vatNumber')} hint={t('optional')}><Input id="st-vat" name="vatNumber" dir="ltr" maxLength={40} /></Field>
          <Field id="st-na" label={t('nationalAddress')} hint={t('optional')}><Input id="st-na" name="nationalAddress" dir="ltr" maxLength={60} /></Field>
        </section>

        <section className="space-y-3">
          <h2 className="font-semibold">{t('terms')}</h2>
          <Field id="st-mode" label={t('creditMode')}>
            <Select id="st-mode" name="creditMode" value={mode} onChange={(e) => setMode(e.target.value)} required>
              <option value="">{t('choose')}</option>
              {(options.data?.creditModes ?? []).map((m) => <option key={m} value={m}>{t(`modes.${m}`)}</option>)}
            </Select>
          </Field>
          {mode === 'CUSTOM' ? <Field id="st-days" label={t('cycleDays')}><Input id="st-days" name="creditCycleDays" inputMode="numeric" dir="ltr" required /></Field> : null}
          <Field id="st-limit" label={t('creditLimit')}><Input id="st-limit" name="creditLimit" inputMode="decimal" dir="ltr" defaultValue="0" /></Field>
          <Field id="st-list" label={t('priceList')}>
            <Select id="st-list" name="priceListId" defaultValue="">
              {(options.data?.priceLists ?? []).map((l) => <option key={l.id} value={l.id}>{format.name(l)}</option>)}
            </Select>
          </Field>
        </section>

        <Button type="submit" block disabled={!ready || onboard.isPending}>{onboard.isPending ? t('saving') : t('onboard')}</Button>
      </form>
    </div>
  );
}
