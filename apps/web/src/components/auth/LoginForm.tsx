'use client';

import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input } from '@gsa/ui';
import { api } from '@/lib/api';
import { formSecret, formText } from '@/lib/forms';
import { useErrorText } from '@/lib/hooks';

type SignedIn = { user: { role: string; mustChangePassword: boolean } };

export function LoginForm() {
  const t = useTranslations('auth');
  const errorText = useErrorText();
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const { user } = await api<SignedIn>('/auth/sign-in', {
        method: 'POST',
        body: { identifier: formText(form, 'identifier'), password: formSecret(form, 'password') },
      });
      // Only same-site paths are honoured as a destination.
      const safeNext = next?.startsWith('/') && !next.startsWith('//') ? next : '/';
      router.replace(user.mustChangePassword ? '/change-password' : safeNext);
      router.refresh();
    } catch (e) {
      setError(errorText(e));
      setPending(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
      {error ? <Alert>{error}</Alert> : null}
      <Field id="identifier" label={t('identifier')}>
        <Input id="identifier" name="identifier" autoComplete="username" inputMode="email" dir="ltr" required autoFocus />
      </Field>
      <Field id="password" label={t('password')}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <Button type="submit" block size="lg" disabled={pending}>{pending ? t('signingIn') : t('signIn')}</Button>
    </form>
  );
}
