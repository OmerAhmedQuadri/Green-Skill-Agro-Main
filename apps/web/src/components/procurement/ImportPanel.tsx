'use client';

import { Download, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type ChangeEvent } from 'react';
import { Alert, Badge, Button } from '@gsa/ui';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useCommand, useErrorText } from '@/lib/hooks';
import { isErrorKey } from '@/i18n/messages';
import type { PoDetail, PreviewRow } from './types';

type Preview = { fileName: string; rows: PreviewRow[]; valid: number; invalid: number };

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * RCV-001/002: download the template, fill it in, upload it. Every row is
 * checked and shown with its problem; nothing is received until confirmed,
 * and only the rows without problems are.
 */
export function ImportPanel({ order, onDone }: { order: PoDetail; onDone: (next: PoDetail | null) => void }) {
  const t = useTranslations();
  const tErrors = useTranslations('errors');
  const errorText = useErrorText();
  const [preview, setPreview] = useState<Preview | null>(null);
  const check = useCommand((body: { fileName: string; content: string }, key) =>
    api<Preview>(`/purchase-orders/${order.id}/receipt-preview`, { method: 'POST', body, idempotencyKey: key }), { onSuccess: setPreview });
  const commit = useCommand((body: unknown, key) => api<PoDetail>(`/purchase-orders/${order.id}/receipts`, { method: 'POST', body, idempotencyKey: key }), { onSuccess: onDone });

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setPreview(null);
    check.run({ fileName: file.name, content: await base64(file) });
  };
  const good = preview?.rows.flatMap((r) => (r.input && !r.error ? [r.input] : [])) ?? [];

  return (
    <Section title={t('receiving.import')} description={t('receiving.importHint')}>
      <div className="flex flex-wrap items-center gap-3 p-5">
        <a href={`/api/v1/purchase-orders/${order.id}/receipt-template`} download
          className="inline-flex h-11 items-center gap-2 rounded-md border border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 hover:bg-stone-50">
          <Download className="size-4" aria-hidden />{t('receiving.downloadTemplate')}
        </a>
        <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-md bg-brand-800 px-4 text-sm font-medium text-white hover:bg-brand-900">
          <Upload className="size-4" aria-hidden />{t('receiving.uploadFile')}
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(e) => void choose(e)} />
        </label>
        <Button variant="ghost" onClick={() => onDone(null)}>{t('common.cancel')}</Button>
      </div>
      {check.isPending ? <p className="px-5 pb-5 text-sm text-stone-500">{t('receiving.checking')}</p> : null}
      {check.error ? <div className="px-5 pb-5"><Alert>{errorText(check.error)}</Alert></div> : null}
      {preview ? (
        <div className="space-y-4 border-t border-stone-200 p-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{preview.fileName}</span>
            <Badge tone="success">{t('receiving.validRows', { count: preview.valid })}</Badge>
            {preview.invalid > 0 ? <Badge tone="danger">{t('receiving.invalidRows', { count: preview.invalid })}</Badge> : null}
          </div>
          <Table head={[t('receiving.row'), t('catalogue.skuCode'), t('receiving.packs'), t('receiving.lotNumber'), t('receiving.manufacturedOn'), t('receiving.expiresOn'), t('receiving.problem')]}>
            {preview.rows.map((r) => (
              <tr key={r.row} className={r.error ? 'bg-red-50' : ''}>
                <Cell>{r.row}</Cell>
                <Cell><bdi dir="ltr" className="font-mono">{r.code || '—'}</bdi></Cell>
                <Cell>{r.input && Number.isInteger(r.input.packs) ? r.input.packs : '—'}</Cell>
                <Cell><bdi dir="ltr">{r.input?.lotNumber ?? '—'}</bdi></Cell>
                <Cell><bdi dir="ltr">{r.input?.manufacturedOn ?? '—'}</bdi></Cell>
                <Cell><bdi dir="ltr">{r.input?.expiresOn ?? '—'}</bdi></Cell>
                <Cell className="text-red-800">
                  {r.error ? `${tErrors(isErrorKey(r.error.code) ? r.error.code : 'INTERNAL_ERROR')}${r.error.field ? ` (${t(`receiving.fields.${r.error.field === 'sku' || r.error.field === 'packs' || r.error.field === 'lotNumber' || r.error.field === 'manufacturedOn' || r.error.field === 'expiresOn' || r.error.field === 'unitCost' ? r.error.field : 'other'}`)})` : ''}` : ''}
                </Cell>
              </tr>
            ))}
          </Table>
          {commit.error ? <Alert>{errorText(commit.error)}</Alert> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={good.length === 0 || commit.isPending}
              onClick={() => commit.run({ version: order.version, source: 'IMPORT', fileName: preview.fileName, lines: good })}>
              {commit.isPending ? t('common.saving') : t('receiving.confirmImport', { count: good.length })}
            </Button>
            {preview.invalid > 0 ? <span className="text-sm text-stone-600">{t('receiving.skipInvalid')}</span> : null}
          </div>
        </div>
      ) : null}
    </Section>
  );
}
