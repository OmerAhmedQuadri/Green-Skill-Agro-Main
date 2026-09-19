'use client';

import { Camera } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input, Select } from '@gsa/ui';
import type { BatchStock } from '@/components/procurement/types';
import { Section } from '@/components/common/Section';
import { api, ApiError } from '@/lib/api';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { uploadMedia } from '@/lib/upload';
import { REASONS, type WriteOff } from './types';

/**
 * Workflow E (WRO-001..003): report a batch as damaged, expired, spoiled or
 * missing, with a photo. Nothing moves until a manager approves it; the packs
 * are held meanwhile.
 */
export function WriteOffPanel({ batch, onDone }: { batch: BatchStock; onDone: (done: WriteOff | null) => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const [photo, setPhoto] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<unknown>(null);
  const [uploading, setUploading] = useState(false);
  const submit = useCommand((body: unknown, key) => api<WriteOff>('/write-offs', { method: 'POST', body, idempotencyKey: key }), { onSuccess: onDone });

  const send = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setUploadError(null);
    if (!photo) { setUploadError(new ApiError(422, 'EVIDENCE_REQUIRED')); return; }
    setUploading(true);
    try {
      const photoId = await uploadMedia('WRITE_OFF_EVIDENCE', photo);
      const packs = formText(f, 'packs');
      submit.run({ batchId: batch.batchId, packs: /^\d+$/.test(packs) ? Number.parseInt(packs, 10) : 0, reason: formText(f, 'reason'), note: formText(f, 'note') || null, photoId });
    } catch (error) {
      setUploadError(error);
    } finally {
      setUploading(false);
    }
  };
  const error = uploadError ?? submit.error;

  return (
    <Section title={t('warehouse.writeOffTitle', { lot: batch.lotNumber ?? '—' })} description={t('warehouse.writeOffHint')}>
      <form className="grid gap-4 p-5 sm:grid-cols-2" noValidate onSubmit={(e) => void send(e)}>
        {error ? <Alert className="sm:col-span-2">{errorText(error)}</Alert> : null}
        <Field id="wo-packs" label={t('warehouse.packsToWriteOff', { held: batch.positions.warehouse })}>
          <Input id="wo-packs" name="packs" inputMode="numeric" dir="ltr" required />
        </Field>
        <Field id="wo-reason" label={t('warehouse.reason')}>
          <Select id="wo-reason" name="reason" defaultValue="DAMAGED">
            {REASONS.map((r) => <option key={r} value={r}>{t(`warehouse.reasons.${r}`)}</option>)}
          </Select>
        </Field>
        <div className="sm:col-span-2"><Field id="wo-note" label={t('warehouse.note')}><Input id="wo-note" name="note" maxLength={500} /></Field></div>
        <div className="sm:col-span-2">
          <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-md border border-stone-300 bg-white px-4 text-sm font-medium hover:bg-stone-50">
            <Camera className="size-4" aria-hidden />{photo ? t('warehouse.photoChosen', { name: photo.name }) : t('warehouse.takePhoto')}
            <input type="file" accept="image/*" capture="environment" className="sr-only" aria-label={t('warehouse.takePhoto')}
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </label>
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" disabled={uploading || submit.isPending}>{uploading || submit.isPending ? t('common.saving') : t('warehouse.submitWriteOff')}</Button>
          <Button variant="ghost" onClick={() => onDone(null)}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Section>
  );
}
