'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select } from '@gsa/ui';
import { api } from '@/lib/api';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { PermissionEditor } from './PermissionEditor';
import { TemporaryPassword } from './TemporaryPassword';
import type { AccountDetail } from './types';

export function AccountView({ id, actorId, actorPermissions, canManagePermissions }: {
  id: string; actorId: string; actorPermissions: string[]; canManagePermissions: boolean;
}) {
  const t = useTranslations();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const account = useQuery({ queryKey: ['user', id], queryFn: () => api<AccountDetail>(`/users/${id}`) });
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const replace = (next: AccountDetail) => {
    queryClient.setQueryData(['user', id], next);
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };
  const update = useCommand((body: Record<string, unknown>, key) =>
    api<AccountDetail>(`/users/${id}`, { method: 'PATCH', body, idempotencyKey: key }), { onSuccess: (a) => { replace(a); setSaved(true); } });
  const setStatus = useCommand((body: { action: 'deactivate' | 'reactivate'; version: number }, key) =>
    api<AccountDetail>(`/users/${id}/${body.action}`, { method: 'POST', body: { version: body.version }, idempotencyKey: key }), { onSuccess: replace });
  const reset = useCommand((_: null, key) =>
    api<{ temporaryPassword: string | null }>(`/users/${id}/reset-password`, { method: 'POST', body: {}, idempotencyKey: key }),
  { onSuccess: (r) => { setTemporaryPassword(r.temporaryPassword); void account.refetch(); } });

  if (account.error) return <Alert>{errorText(account.error)}</Alert>;
  if (!account.data) return <p className="text-sm text-stone-500">{t('common.loading')}</p>;
  const a = account.data;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    const f = new FormData(event.currentTarget);
    const text = (name: string) => formText(f, name);
    update.run({ version: a.version, name: text('name'), email: text('email') || null, phone: text('phone') || null, locale: text('locale') });
  };
  const error = update.error ?? setStatus.error ?? reset.error;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link href="/console/users" className="inline-flex items-center gap-1.5 text-sm text-stone-600 hover:text-stone-900">
        <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />{t('users.title')}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{a.name}</h1>
        <Badge>{t(`roles.${a.role}`)}</Badge>
        <Badge tone={a.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`status.${a.status}`)}</Badge>
        {a.mustChangePassword ? <Badge tone="warning">{t('users.mustChangeBadge')}</Badge> : null}
      </div>

      {error ? <Alert>{errorText(error)}</Alert> : null}
      {temporaryPassword ? <TemporaryPassword value={temporaryPassword} title={t('users.resetPassword')} /> : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={t('users.profile')} />
          <form key={a.version} onSubmit={submit} className="grid gap-4 p-5 sm:grid-cols-2" noValidate>
            <Field id="name" label={t('users.fieldName')}><Input id="name" name="name" defaultValue={a.name} required /></Field>
            <Field id="locale" label={t('users.fieldLocale')}>
              <Select id="locale" name="locale" defaultValue={a.locale}>
                <option value="ar">{t('locales.ar')}</option>
                <option value="en">{t('locales.en')}</option>
              </Select>
            </Field>
            <Field id="email" label={t('users.fieldEmail')}><Input id="email" name="email" type="email" dir="ltr" defaultValue={a.email ?? ''} /></Field>
            <Field id="phone" label={t('users.fieldPhone')}><Input id="phone" name="phone" type="tel" dir="ltr" defaultValue={a.phone ?? ''} /></Field>
            <div className="flex items-center gap-3 sm:col-span-2">
              <Button type="submit" disabled={update.isPending}>{update.isPending ? t('common.saving') : t('common.save')}</Button>
              {saved ? <span className="text-sm text-brand-700">{t('users.saved')}</span> : null}
            </div>
          </form>
        </Card>

        <Card>
          <CardHeader title={t('users.account')} />
          <div className="space-y-3 p-5">
            <Button variant="secondary" block disabled={reset.isPending}
              onClick={() => { if (window.confirm(t('users.resetConfirm', { name: a.name }))) reset.run(null); }}>
              {t('users.resetPassword')}
            </Button>
            {a.id !== actorId ? (a.status === 'ACTIVE' ? (
              <Button variant="danger" block disabled={setStatus.isPending}
                onClick={() => { if (window.confirm(t('users.deactivateConfirm', { name: a.name }))) setStatus.run({ action: 'deactivate', version: a.version }); }}>
                {t('users.deactivate')}
              </Button>
            ) : (
              <Button variant="secondary" block disabled={setStatus.isPending} onClick={() => setStatus.run({ action: 'reactivate', version: a.version })}>
                {t('users.reactivate')}
              </Button>
            )) : null}
          </div>
        </Card>
      </div>

      {canManagePermissions && a.configurable.length > 0 ? (
        <PermissionEditor key={`${a.id}-${a.permissions.join()}`} account={a} actorPermissions={actorPermissions} />
      ) : null}
    </div>
  );
}
