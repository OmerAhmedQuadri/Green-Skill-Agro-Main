'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import type { system } from '@gsa/services';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Card, Input } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';

type Entry = system.AuditEntryView;
type Page = { items: Entry[]; nextCursor: string | null };

const json = (v: unknown) => (v === null || v === undefined ? '' : JSON.stringify(v, null, 1));

/**
 * AUD-001..004: every sensitive action — who, what, when — for Super Admin and
 * Admin. Actions and entities are shown by their codes; the before and after
 * values are the record as it was written.
 */
export function AuditLogPage() {
  const t = useTranslations('audit');
  const format = useFormat();
  const errorText = useErrorText();
  const [action, setAction] = useState('');
  const [entityId, setEntityId] = useState('');
  const filter = { action: action.trim(), entityId: entityId.trim() };
  const log = useInfiniteQuery({
    queryKey: keys.auditLog(filter),
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (filter.action) qs.set('action', filter.action);
      if (filter.entityId) qs.set('entityId', filter.entityId);
      if (pageParam) qs.set('cursor', pageParam);
      return api<Page>(`/audit-log?${qs.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries = log.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 p-4">
          <Input value={action} onChange={(e) => setAction(e.target.value)} aria-label={t('action')} placeholder={t('action')} className="w-56" dir="ltr" />
          <Input value={entityId} onChange={(e) => setEntityId(e.target.value)} aria-label={t('entityId')} placeholder={t('entityId')} className="w-80" dir="ltr" />
        </div>
        {log.error ? <div className="p-4"><Alert>{errorText(log.error)}</Alert></div> : null}
        {log.data && entries.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('empty')}</p> : null}
        {entries.length > 0 ? (
          <Table head={[t('when'), t('who'), t('action'), t('entity'), t('change')]}>
            {entries.map((e) => (
              <tr key={e.id} data-testid={`audit-${e.action}`}>
                <Cell className="whitespace-nowrap">{format.dateTime(e.occurredAt)}</Cell>
                <Cell>{e.actor?.name ?? t('system')}</Cell>
                <Cell><code dir="ltr" className="text-xs">{e.action}</code></Cell>
                <Cell><code dir="ltr" className="text-xs">{e.entityType}{e.entityId ? ` ${e.entityId}` : ''}</code></Cell>
                <Cell>
                  <details>
                    <summary className="cursor-pointer text-xs text-brand-800">{t('show')}</summary>
                    <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                      <div><div className="font-medium text-stone-500">{t('before')}</div><pre dir="ltr" className="overflow-x-auto whitespace-pre-wrap">{json(e.before) || '—'}</pre></div>
                      <div><div className="font-medium text-stone-500">{t('after')}</div><pre dir="ltr" className="overflow-x-auto whitespace-pre-wrap">{json(e.after) || '—'}</pre></div>
                    </div>
                  </details>
                </Cell>
              </tr>
            ))}
          </Table>
        ) : null}
        {log.hasNextPage ? (
          <div className="border-t border-stone-200 p-4"><Button variant="secondary" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>{t('more')}</Button></div>
        ) : null}
      </Card>
    </div>
  );
}
