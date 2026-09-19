'use client';

import { FileUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert } from '@gsa/ui';
import { useErrorText } from '@/lib/hooks';
import { uploadMedia, type MediaKind } from '@/lib/upload';

/**
 * Evidence from a file — a photo or a PDF — for kinds that need no live camera
 * (ARCHITECTURE §6.4), such as a transport slip (DSP-006). Photos are
 * compressed before upload; the server checks the real type.
 */
export function EvidenceUpload({ id, kind, label, onChange }: {
  id: string; kind: Extract<MediaKind, 'TRANSPORT_SLIP' | 'DEPOSIT_SLIP'>; label: string; onChange: (mediaId: string | null) => void;
}) {
  const t = useTranslations('camera');
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pick = async (file: File | undefined) => {
    onChange(null);
    setName(null);
    setError(null);
    if (!file) return;
    setBusy(true);
    try {
      onChange(await uploadMedia(kind, file));
      setName(file.name);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div id={id} className="space-y-2">
      <label htmlFor={`${id}-file`} className="block text-sm font-medium text-stone-700">{label}</label>
      <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-md border border-stone-300 px-4 text-sm font-medium hover:bg-stone-50">
        <FileUp className="size-4" aria-hidden />{busy ? t('uploading') : t('chooseFile')}
        <input id={`${id}-file`} type="file" accept="image/jpeg,image/png,application/pdf" className="sr-only" disabled={busy}
          onChange={(e) => void pick(e.target.files?.[0])} />
      </label>
      {name ? <p className="text-sm text-brand-800" data-testid={`${id}-ready`}>{t('fileReady', { name })}</p> : null}
      {error ? <Alert>{errorText(error)}</Alert> : null}
    </div>
  );
}
