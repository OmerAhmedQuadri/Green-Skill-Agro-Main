'use client';

import { CORRECTION_CLOSINGS, type CorrectionClosing } from '@gsa/core';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Textarea } from '@gsa/ui';
import { api } from '@/lib/api';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { CorrectionSession } from './status';

/**
 * COR-003: closing a correction session settles its reason — kept, added to, or edited. An edit keeps the
 * original, which the Corrections page shows struck through.
 */
export function CloseSessionForm({ session, onDone, onCancel }: { session: CorrectionSession; onDone?: () => void; onCancel?: () => void }) {
  const t = useTranslations('corrections.close');
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [closing, setClosing] = useState<CorrectionClosing>('KEPT');
  const close = useCommand((body: { version: number; closing: CorrectionClosing; text: string | null }, key) =>
    api<CorrectionSession>(`/corrections/sessions/${session.id}/close`, { method: 'POST', body, idempotencyKey: key }), {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.correctionStatus });
      void queryClient.invalidateQueries({ queryKey: keys.correctionSessions });
      onDone?.();
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = closing === 'KEPT' ? null : formText(new FormData(event.currentTarget), 'closingText');
    close.run({ version: session.version, closing, text });
  };

  const textId = `close-${session.id}-text`;
  return (
    <form onSubmit={submit} className="space-y-4 text-stone-800" data-testid="correction-close" noValidate>
      <h3 className="text-sm font-semibold text-stone-900">{t('title', { number: session.number })}</h3>
      {close.error ? <Alert>{errorText(close.error)}</Alert> : null}
      <div>
        <div className="text-xs font-medium text-stone-500">{t('reason')}</div>
        <p className="mt-1 whitespace-pre-wrap text-sm text-stone-900">{session.reason}</p>
      </div>
      <fieldset className="flex flex-wrap gap-x-6 gap-y-2">
        {CORRECTION_CLOSINGS.map((c) => (
          <label key={c} className="flex items-center gap-2 text-sm">
            <input type="radio" name={`closing-${session.id}`} value={c} checked={closing === c} onChange={() => setClosing(c)} className="accent-brand-700" />
            {t(c)}
          </label>
        ))}
      </fieldset>
      {closing === 'KEPT' ? null : (
        <Field id={textId} label={t(closing === 'ADDED' ? 'addText' : 'editText')} hint={closing === 'EDITED' ? t('editHint') : undefined}>
          <Textarea key={closing} id={textId} name="closingText" maxLength={1000} required defaultValue={closing === 'EDITED' ? session.reason : ''} />
        </Field>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={close.isPending}>{t('submit')}</Button>
        {onCancel ? <Button type="button" variant="secondary" onClick={onCancel}>{t('cancel')}</Button> : null}
      </div>
    </form>
  );
}
