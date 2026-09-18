'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input, Select } from '@gsa/ui';
import { api } from '@/lib/api';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { TemporaryPassword } from './TemporaryPassword';
import type { AccountDetail, Role } from './types';

type Input = { role: Role; name: string; email?: string; phone?: string; locale: 'en' | 'ar' };
type Created = { account: AccountDetail; temporaryPassword: string | null };

export function CreateAccountForm({ roles, onDone }: { roles: Role[]; onDone: () => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<Created | null>(null);
  const create = useCommand((input: Input, key) => api<Created>('/users', { method: 'POST', body: input, idempotencyKey: key }), {
    onSuccess: (result) => { setCreated(result); void queryClient.invalidateQueries({ queryKey: ['users'] }); },
  });

  if (created) {
    return (
      <div className="space-y-4">
        {created.temporaryPassword
          ? <TemporaryPassword value={created.temporaryPassword} title={t('users.created', { name: created.account.name })} />
          : <Alert tone="success">{t('users.created', { name: created.account.name })}</Alert>}
        <Button variant="secondary" onClick={onDone}>{t('common.back')}</Button>
      </div>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (name: string) => formText(f, name);
    create.run({
      role: text('role') as Role, name: text('name'), locale: text('locale') === 'ar' ? 'ar' : 'en',
      ...(text('email') ? { email: text('email') } : {}), ...(text('phone') ? { phone: text('phone') } : {}),
    });
  };

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
      {create.error ? <Alert className="sm:col-span-2">{errorText(create.error)}</Alert> : null}
      <Field id="name" label={t('users.fieldName')}><Input id="name" name="name" required maxLength={120} /></Field>
      <Field id="role" label={t('users.fieldRole')}>
        <Select id="role" name="role" defaultValue={roles.includes('SELLER') ? 'SELLER' : roles[0]}>
          {roles.map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
        </Select>
      </Field>
      <Field id="email" label={t('users.fieldEmail')} hint={t('users.identifierHint')}>
        <Input id="email" name="email" type="email" dir="ltr" autoComplete="off" />
      </Field>
      <Field id="phone" label={t('users.fieldPhone')}>
        <Input id="phone" name="phone" type="tel" dir="ltr" inputMode="tel" autoComplete="off" />
      </Field>
      <Field id="locale" label={t('users.fieldLocale')}>
        <Select id="locale" name="locale" defaultValue="ar">
          <option value="ar">{t('locales.ar')}</option>
          <option value="en">{t('locales.en')}</option>
        </Select>
      </Field>
      <div className="flex items-end gap-2 sm:col-span-2">
        <Button type="submit" disabled={create.isPending}>{create.isPending ? t('common.saving') : t('users.create')}</Button>
        <Button variant="ghost" onClick={onDone}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}
