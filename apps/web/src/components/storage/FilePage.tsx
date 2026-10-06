'use client';

import type { media } from '@gsa/services';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Alert, Button, Card } from '@gsa/ui';
import { Facts } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { usePeriodText } from './periods';

type Details = media.FileDetails;

/**
 * ADR-0049: one stored file — the photo itself, or a link to the PDF — with
 * how long it is kept and, for a Super Admin or Admin, the button that keeps
 * it forever (SYS-011). A deleted file says when it went.
 */
export function FilePage({ id }: { id: string }) {
  const t = useTranslations('file');
  const format = useFormat();
  const periodText = usePeriodText();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const details = useQuery({ queryKey: keys.file(id), queryFn: () => api<Details>(`/media/${id}/details`) });
  const keep = useCommand((value: boolean, key) => api<Details>(`/media/${id}/keep`, { method: 'PUT', body: { keep: value }, idempotencyKey: key }), {
    onSuccess: (next) => queryClient.setQueryData(keys.file(id), next),
  });

  if (details.error) return <Alert>{errorText(details.error)}</Alert>;
  const f = details.data;
  if (!f) return null;
  const src = `/api/v1/media/${f.id}`;
  const title = t(`kinds.${f.kind}`);

  const standing = f.status === 'PURGED' ? null
    : f.kept ? t('keptBy', { name: f.kept.by, date: format.dateTime(f.kept.at) })
      : f.period === 'FOREVER' || !f.deletesOn ? t('keptByPolicy')
        : `${t('deletesOn', { date: format.date(f.deletesOn) })}${f.open ? ` ${t('openRecord')}` : ''}`;

  return (
    <Card className="overflow-hidden" data-testid="file-page">
      <h1 className="border-b border-stone-200 px-5 py-4 text-xl font-semibold">{title}</h1>
      {f.status === 'PURGED' ? (
        <div className="p-5"><Alert tone="info" data-testid="file-deleted">{t('deleted', { date: format.dateTime(f.purgedAt ?? f.storedAt) })}</Alert></div>
      ) : f.contentType === 'application/pdf' ? (
        <div className="p-5">
          <a href={src} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center gap-2 rounded-md border border-stone-300 px-4 text-sm font-medium hover:bg-stone-50">
            <FileText className="size-4" aria-hidden />{t('open')}
          </a>
        </div>
      ) : (
        <a href={src} target="_blank" rel="noreferrer" className="block bg-stone-100" aria-label={t('open')}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a five-minute signed URL behind a redirect, not an optimisable asset */}
          <img src={src} alt={title} className="mx-auto max-h-[70vh] object-contain" />
        </a>
      )}
      <Facts items={[
        { label: t('stored'), value: format.dateTime(f.storedAt) },
        ...(f.capturedAt ? [{ label: t('taken'), value: format.dateTime(f.capturedAt) }] : []),
        { label: t('by'), value: f.uploadedBy },
        { label: t('size'), value: f.byteSize === null ? '—' : format.bytes(f.byteSize) },
        { label: t('keptFor'), value: periodText(f.period) },
      ]} />
      {standing ? <p className="px-5 pb-4 text-sm text-stone-700" data-testid="file-standing">{standing}</p> : null}
      {f.canKeep ? (
        <div className="space-y-2 border-t border-stone-200 p-5">
          {keep.error ? <Alert>{errorText(keep.error)}</Alert> : null}
          <Button variant={f.kept ? 'secondary' : 'primary'} disabled={keep.isPending} onClick={() => keep.run(!f.kept)}>
            {f.kept ? t('release') : t('keep')}
          </Button>
          <p className="text-xs text-stone-500">{t('keepHint')}</p>
        </div>
      ) : null}
    </Card>
  );
}
