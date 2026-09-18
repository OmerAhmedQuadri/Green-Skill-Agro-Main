'use client';

import { useTranslations } from 'next-intl';
import type { FormEvent } from 'react';
import { Alert, Button, Field, Input } from '@gsa/ui';
import { CountrySelect } from '@/components/common/CountrySelect';
import type { ApiError } from '@/lib/api';
import { formText } from '@/lib/forms';
import { useErrorText } from '@/lib/hooks';
import type { Vendor } from './types';

export type VendorInput = {
  code?: string; name: string; country: string; address: string | null; contactPerson: string | null; phone: string | null; email: string | null;
};

/** VEN-001: code, name, address, contact person, telephone, email, country. The code is fixed once created. */
export function VendorForm({ vendor, submitLabel, pending, error, onSubmit, onCancel }: {
  vendor?: Vendor; submitLabel: string; pending: boolean; error: ApiError | null; onSubmit: (v: VendorInput) => void; onCancel: () => void;
}) {
  const t = useTranslations();
  const errorText = useErrorText();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (name: string) => formText(f, name);
    onSubmit({
      ...(vendor ? {} : { code: text('code') }),
      name: text('name'), country: text('country'),
      address: text('address') || null, contactPerson: text('contactPerson') || null, phone: text('phone') || null, email: text('email') || null,
    });
  };
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
      {error ? <Alert className="sm:col-span-2">{errorText(error)}</Alert> : null}
      <Field id="vendor-code" label={t('vendors.code')} hint={vendor ? t('vendors.codeFixed') : t('vendors.codeHint')}>
        <Input id="vendor-code" name="code" dir="ltr" className="font-mono uppercase" maxLength={20} required
          defaultValue={vendor?.code} disabled={Boolean(vendor)} />
      </Field>
      <Field id="vendor-name" label={t('vendors.name')}><Input id="vendor-name" name="name" required maxLength={200} defaultValue={vendor?.name} /></Field>
      <Field id="vendor-country" label={t('vendors.country')}><CountrySelect id="vendor-country" name="country" defaultValue={vendor?.country} required /></Field>
      <Field id="vendor-contact" label={t('vendors.contactPerson')}><Input id="vendor-contact" name="contactPerson" maxLength={200} defaultValue={vendor?.contactPerson ?? ''} /></Field>
      <Field id="vendor-phone" label={t('vendors.phone')} hint={t('vendors.phoneHint')}>
        <Input id="vendor-phone" name="phone" type="tel" dir="ltr" inputMode="tel" maxLength={32} defaultValue={vendor?.phone ?? ''} />
      </Field>
      <Field id="vendor-email" label={t('vendors.email')}><Input id="vendor-email" name="email" type="email" dir="ltr" maxLength={254} defaultValue={vendor?.email ?? ''} /></Field>
      <div className="sm:col-span-2">
        <Field id="vendor-address" label={t('vendors.address')}><Input id="vendor-address" name="address" maxLength={500} defaultValue={vendor?.address ?? ''} /></Field>
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={pending}>{pending ? t('common.saving') : submitLabel}</Button>
        <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}
