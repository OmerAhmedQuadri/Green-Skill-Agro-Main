'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input } from '@gsa/ui';
import { api } from '@/lib/api';
import { formSecret } from '@/lib/forms';
import { useErrorText } from '@/lib/hooks';

export function ResetPasswordForm() {
  const t = useTranslations('auth');
  const errorText = useErrorText();
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'idle' | 'saving' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = formSecret(form, 'newPassword');
    if (newPassword !== formSecret(form, 'confirmPassword')) {
      setError(t('passwordsDontMatch'));
      return;
    }
    setState('saving');
    setError(null);
    try {
      await api('/auth/password/reset', { method: 'POST', body: { token, newPassword } });
      setState('done');
    } catch (e) {
      setError(errorText(e));
      setState('idle');
    }
  };

  if (state === 'done') {
    return (
      <div className="space-y-4">
        <Alert tone="success">{t('resetDone')}</Alert>
        <Link href="/login" className="text-sm font-medium text-brand-800 hover:underline">{t('backToSignIn')}</Link>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
      {error ? <Alert>{error}</Alert> : null}
      <Field id="newPassword" label={t('newPassword')} hint={t('passwordHint')}>
        <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={10} required autoFocus />
      </Field>
      <Field id="confirmPassword" label={t('confirmPassword')}>
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required />
      </Field>
      <Button type="submit" block size="lg" disabled={state === 'saving'}>{t('setPassword')}</Button>
    </form>
  );
}
