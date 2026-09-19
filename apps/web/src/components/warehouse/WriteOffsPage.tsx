'use client';

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import type { WriteOff } from './types';

type Page = { items: WriteOff[]; nextCursor: string | null };
const TONE = { SUBMITTED: 'warning', APPROVED: 'success', REJECTED: 'neutral' } as const;

/**
 * Workflow E: write-offs waiting for a decision, and those decided. A manager
 * approves — as submitted or for fewer packs — or rejects with a comment; the
 * submitter never decides their own (four-eyes).
 */
export function WriteOffsPage({ canDecide, userId }: { canDecide: boolean; userId: string }) {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'SUBMITTED' | 'APPROVED' | 'REJECTED' | ''>('SUBMITTED');
  const [deciding, setDeciding] = useState<string | null>(null);
  const list = useInfiniteQuery({
    queryKey: ['write-offs', status],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (status) qs.set('status', status);
      if (pageParam) qs.set('cursor', pageParam);
      return api<Page>(`/write-offs?${qs.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const decide = useCommand(({ id, ...body }: { id: string; version: number; approve: boolean; approvedPacks: number | null; comment: string | null }, key) =>
    api<WriteOff>(`/write-offs/${id}/decide`, { method: 'POST', body, idempotencyKey: key }),
  { onSuccess: () => { setDeciding(null); void queryClient.invalidateQueries({ queryKey: ['write-offs'] }); void queryClient.invalidateQueries({ queryKey: ['sku-stock'] }); } });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  const submit = (w: WriteOff, approve: boolean) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const packs = formText(f, 'approvedPacks');
    decide.run({ id: w.id, version: w.version, approve, approvedPacks: approve && /^\d+$/.test(packs) ? Number.parseInt(packs, 10) : null, comment: formText(f, 'comment') || null });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('warehouse.writeOffsTitle')} subtitle={t('warehouse.writeOffsSubtitle')} />
      <Card>
        <div className="border-b border-stone-200 p-4">
          <Select value={status} onChange={(e) => setStatus((['SUBMITTED', 'APPROVED', 'REJECTED', ''] as const).find((s) => s === e.target.value) ?? '')} aria-label={t('common.status')} className="w-auto">
            <option value="SUBMITTED">{t('warehouse.statuses.SUBMITTED')}</option>
            <option value="APPROVED">{t('warehouse.statuses.APPROVED')}</option>
            <option value="REJECTED">{t('warehouse.statuses.REJECTED')}</option>
            <option value="">{t('common.all')}</option>
          </Select>
        </div>
        {list.error ? <div className="p-4"><Alert>{errorText(list.error)}</Alert></div> : null}
        {decide.error ? <div className="p-4"><Alert>{errorText(decide.error)}</Alert></div> : null}
        {list.isPending ? <p className="p-5 text-sm text-stone-500">{t('common.loading')}</p> : null}
        {!list.isPending && rows.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('warehouse.noWriteOffs')}</p> : null}
        {rows.length > 0 ? (
          <Table head={[t('warehouse.number'), t('catalogue.skuCode'), t('receiving.lotNumber'), t('warehouse.packs'), t('warehouse.reason'), t('warehouse.submitted'), t('common.status'), '']}>
            {rows.flatMap((w) => [
              <tr key={w.id} className="align-top">
                <Cell><bdi dir="ltr" className="font-mono">{w.number}</bdi></Cell>
                <Cell><bdi dir="ltr" className="font-mono">{w.code}</bdi><div className="text-xs text-stone-500">{format.name(w.product)}</div></Cell>
                <Cell><bdi dir="ltr">{w.lotNumber ?? '—'}</bdi></Cell>
                <Cell>{w.requestedPacks !== null ? format.number(w.requestedPacks) : t('warehouse.partPack')}</Cell>
                <Cell>{t(`warehouse.reasons.${w.reason}`)}{w.note ? <div className="text-xs text-stone-500">{w.note}</div> : null}</Cell>
                <Cell>{w.submittedBy.name}<div className="text-xs text-stone-500">{format.dateTime(w.submittedAt)}</div></Cell>
                <Cell>
                  <Badge tone={TONE[w.status]}>{t(`warehouse.statuses.${w.status}`)}</Badge>
                  {w.decisionComment ? <div className="mt-1 text-xs text-stone-500">{w.decisionComment}</div> : null}
                </Cell>
                <Cell className="text-end">
                  {w.photoId ? <a href={`/api/v1/media/${w.photoId}`} target="_blank" rel="noreferrer" className="me-2 text-sm text-brand-800 hover:underline">{t('warehouse.viewPhoto')}</a> : null}
                  {canDecide && w.status === 'SUBMITTED' && w.submittedBy.id !== userId && deciding !== w.id
                    ? <Button size="sm" variant="secondary" onClick={() => setDeciding(w.id)}>{t('warehouse.decide')}</Button> : null}
                </Cell>
              </tr>,
              deciding === w.id ? (
                <tr key={`${w.id}-decide`}>
                  <td colSpan={8} className="bg-stone-50 p-4">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <form className="flex flex-wrap items-end gap-3" noValidate onSubmit={submit(w, true)}>
                        <Field id={`ap-${w.id}`} label={t('warehouse.approvedPacks', { max: w.requestedPacks ?? 0 })}>
                          <Input id={`ap-${w.id}`} name="approvedPacks" defaultValue={w.requestedPacks ?? ''} inputMode="numeric" dir="ltr" className="w-24" />
                        </Field>
                        <Field id={`ac-${w.id}`} label={t('warehouse.comment')}><Input id={`ac-${w.id}`} name="comment" maxLength={500} /></Field>
                        <Button type="submit" disabled={decide.isPending}>{t('warehouse.approve')}</Button>
                      </form>
                      <form className="flex flex-wrap items-end gap-3" noValidate onSubmit={submit(w, false)}>
                        <Field id={`rc-${w.id}`} label={t('warehouse.rejectComment')}><Input id={`rc-${w.id}`} name="comment" maxLength={500} /></Field>
                        <Button type="submit" variant="danger" disabled={decide.isPending}>{t('warehouse.reject')}</Button>
                        <Button variant="ghost" onClick={() => setDeciding(null)}>{t('common.cancel')}</Button>
                      </form>
                    </div>
                  </td>
                </tr>
              ) : null,
            ])}
          </Table>
        ) : null}
        {list.hasNextPage ? (
          <div className="border-t border-stone-200 p-3 text-center">
            <Button variant="ghost" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>{t('common.loadMore')}</Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
