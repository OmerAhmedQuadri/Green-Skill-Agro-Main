'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input } from '@gsa/ui';
import { api } from '@/lib/api';
import { formSecret } from '@/lib/forms';
import { useErrorText } from '@/lib/hooks';

export function ChangePasswordForm() {
  const t = useTranslations('auth');
  const errorText = useErrorText();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = formSecret(form, 'newPassword');
    if (newPassword !== formSecret(form, 'confirmPassword')) {
      setError(t('passwordsDontMatch'));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api('/auth/password/change', {
        method: 'POST',
        body: { currentPassword: formSecret(form, 'currentPassword'), newPassword },
      });
      router.replace('/');
      router.refresh();
    } catch (e) {
      setError(errorText(e));
      setPending(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
      {error ? <Alert>{error}</Alert> : null}
      <Field id="currentPassword" label={t('currentPassword')}>
        <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
      </Field>
      <Field id="newPassword" label={t('newPassword')} hint={t('passwordHint')}>
        <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={10} required />
      </Field>
      <Field id="confirmPassword" label={t('confirmPassword')}>
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required />
      </Field>
      <Button type="submit" block size="lg" disabled={pending}>{t('changePassword')}</Button>
    </form>
  );
}
