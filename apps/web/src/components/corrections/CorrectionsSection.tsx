'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input, Textarea } from '@gsa/ui';
import { Section } from '@/components/common/Section';
import { api, type ApiError } from '@/lib/api';
import { formSecret, formText } from '@/lib/forms';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { CloseSessionForm } from './CloseSessionForm';
import { useCorrectionStatus, type CorrectionSession } from './status';

/**
 * COR-001: Settings → Correct history, the Super Admin's alone. Off by default; opening a session takes their
 * password and a reason, and it switches itself off after an hour.
 */
export function CorrectionsSection() {
  const t = useTranslations('corrections.settings');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const status = useCorrectionStatus();
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  // Not a command: the body carries a password, so the request has no Idempotency-Key (API.md).
  const open = useMutation<CorrectionSession, ApiError, { password: string; reason: string }>({
    mutationFn: (body) => api<CorrectionSession>('/corrections/sessions', { method: 'POST', body }),
    onSuccess: (session) => {
      queryClient.setQueryData(keys.correctionStatus, (old: { others?: unknown[] } | undefined) => ({ others: old?.others ?? [], mine: session }));
      void queryClient.invalidateQueries({ queryKey: keys.correctionStatus });
      void queryClient.invalidateQueries({ queryKey: keys.correctionSessions });
      setOpening(false);
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    open.mutate({ password: formSecret(f, 'password'), reason: formText(f, 'reason') });
  };

  const mine = status.data?.mine ?? null;
  return (
    <Section title={t('title')} description={t('hint')} id="correct-history">
      <div className="space-y-4 p-5" data-testid="corrections-settings">
        {status.error ? <Alert>{errorText(status.error)}</Alert> : null}
        {!status.data ? null : !mine ? (
          <>
            <p className="text-sm text-stone-700">{t('off')}</p>
            {opening ? (
              <form onSubmit={submit} className="max-w-xl space-y-4" noValidate>
                {open.error ? <Alert>{errorText(open.error)}</Alert> : null}
                <Field id="correction-password" label={t('password')}>
                  <Input id="correction-password" name="password" type="password" autoComplete="current-password" required />
                </Field>
                <Field id="correction-reason" label={t('reason')} hint={t('reasonHint')}>
                  <Textarea id="correction-reason" name="reason" maxLength={1000} required />
                </Field>
                <Alert tone="warning">{t('warning')}</Alert>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={open.isPending}>{t('submit')}</Button>
                  <Button type="button" variant="secondary" onClick={() => { setOpening(false); open.reset(); }}>{t('cancel')}</Button>
                </div>
              </form>
            ) : (
              <Button onClick={() => setOpening(true)}>{t('open')}</Button>
            )}
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-stone-900">
              {mine.state === 'OPEN' ? t('isOpen', { time: format.time(mine.endsAt) }) : t('ended', { time: format.dateTime(mine.endsAt) })}
            </p>
            {mine.state === 'OPEN' && !closing ? (
              <>
                <p className="whitespace-pre-wrap text-sm text-stone-700">{mine.reason}</p>
                <Button variant="secondary" onClick={() => setClosing(true)}>{t('close')}</Button>
              </>
            ) : (
              <CloseSessionForm session={mine} onDone={() => setClosing(false)} {...(mine.state === 'OPEN' ? { onCancel: () => setClosing(false) } : {})} />
            )}
          </>
        )}
      </div>
    </Section>
  );
}
