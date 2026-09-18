'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input } from '@gsa/ui';
import { api } from '@/lib/api';
import { formText } from '@/lib/forms';
import { useErrorText } from '@/lib/hooks';

export function ForgotPasswordForm() {
  const t = useTranslations('auth');
  const errorText = useErrorText();
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setState('sending');
    setError(null);
    try {
      await api('/auth/password/forgot', { method: 'POST', body: { email: formText(new FormData(event.currentTarget), 'email') } });
      setState('sent');
    } catch (e) {
      setError(errorText(e));
      setState('idle');
    }
  };

  if (state === 'sent') return <Alert tone="success">{t('linkSent')}</Alert>;
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
      {error ? <Alert>{error}</Alert> : null}
      <Field id="email" label={t('email')} hint={t('noEmailHint')}>
        <Input id="email" name="email" type="email" dir="ltr" autoComplete="email" required autoFocus />
      </Field>
      <Button type="submit" block size="lg" disabled={state === 'sending'}>{t('sendLink')}</Button>
    </form>
  );
}
