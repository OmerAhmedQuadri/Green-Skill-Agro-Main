'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input, Select } from '@gsa/ui';
import { PhotoCapture } from '@/components/common/PhotoCapture';
import { REASONS, type WriteOff } from '@/components/warehouse/types';
import { api } from '@/lib/api';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import type { MyVehicleBatch } from './types';

/**
 * WRO-001 from the phone: the seller reports stock on their own vehicle, with
 * a photo. It is held there until a manager decides (ADR-0029).
 */
export function FieldWriteOff({ batch, onDone }: { batch: MyVehicleBatch; onDone: (w: WriteOff | null) => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const [photoId, setPhotoId] = useState<string | null>(null);
  const submit = useCommand((body: unknown, key) => api<WriteOff>('/write-offs', { method: 'POST', body, idempotencyKey: key }), { onSuccess: onDone });
  const send = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const packs = formText(f, 'packs');
    submit.run({ batchId: batch.batchId, packs: /^\d+$/.test(packs) ? Number.parseInt(packs, 10) : 0, reason: formText(f, 'reason'), note: formText(f, 'note') || null, photoId });
  };
  return (
    <form className="space-y-3 border-t border-stone-200 p-4" noValidate onSubmit={send} aria-label={t('warehouse.writeOffTitle', { lot: batch.lotNumber ?? '—' })}>
      {submit.error ? <Alert>{errorText(submit.error)}</Alert> : null}
      <Field id={`fw-packs-${batch.batchId}`} label={t('warehouse.packsToWriteOff', { held: batch.packs - batch.heldPacks })}>
        <Input id={`fw-packs-${batch.batchId}`} name="packs" inputMode="numeric" dir="ltr" required />
      </Field>
      <Field id={`fw-reason-${batch.batchId}`} label={t('warehouse.reason')}>
        <Select id={`fw-reason-${batch.batchId}`} name="reason" defaultValue="DAMAGED">
          {REASONS.map((r) => <option key={r} value={r}>{t(`warehouse.reasons.${r}`)}</option>)}
        </Select>
      </Field>
      <Field id={`fw-note-${batch.batchId}`} label={t('warehouse.note')}><Input id={`fw-note-${batch.batchId}`} name="note" maxLength={500} /></Field>
      <PhotoCapture id={`fw-photo-${batch.batchId}`} kind="WRITE_OFF_EVIDENCE" label={t('warehouse.takePhoto')} onChange={setPhotoId} />
      <div className="flex gap-2">
        <Button type="submit" disabled={!photoId || submit.isPending}>{submit.isPending ? t('common.saving') : t('warehouse.submitWriteOff')}</Button>
        <Button variant="ghost" onClick={() => onDone(null)}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}
