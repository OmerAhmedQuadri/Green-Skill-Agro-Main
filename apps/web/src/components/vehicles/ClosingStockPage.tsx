'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { formText } from '@/lib/forms';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { ClosingDeclaration } from './types';

type Status = 'VARIANCE_FLAGGED' | 'MATCHED' | 'REVIEWED' | '';
const TONE = { MATCHED: 'success', VARIANCE_FLAGGED: 'danger', REVIEWED: 'neutral' } as const;

/**
 * STK-010, 011: sellers' daily closing counts. A difference is flagged, never
 * adjusted; a manager records what they found. A real loss is then raised as
 * a write-off.
 */
export function ClosingStockPage() {
  const t = useTranslations();
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('VARIANCE_FLAGGED');
  const list = useQuery({
    queryKey: keys.closingStock({ status }),
    queryFn: () => api<ClosingDeclaration[]>(`/closing-stock-declarations${status ? `?status=${status}` : ''}`),
  });
  const review = useCommand(({ id, ...body }: { id: string; version: number; comment: string }, key) =>
    api(`/closing-stock-declarations/${id}/review`, { method: 'POST', body, idempotencyKey: key }),
  { onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.closingStock() }) });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('closing.title')} subtitle={t('closing.subtitle')} />
      <Card>
        <div className="border-b border-stone-200 p-4">
          <Select value={status} aria-label={t('common.status')} className="w-auto"
            onChange={(e) => setStatus((['VARIANCE_FLAGGED', 'MATCHED', 'REVIEWED', ''] as const).find((s) => s === e.target.value) ?? '')}>
            <option value="VARIANCE_FLAGGED">{t('closing.statuses.VARIANCE_FLAGGED')}</option>
            <option value="MATCHED">{t('closing.statuses.MATCHED')}</option>
            <option value="REVIEWED">{t('closing.statuses.REVIEWED')}</option>
            <option value="">{t('common.all')}</option>
          </Select>
        </div>
        {list.error ? <div className="p-4"><Alert>{errorText(list.error)}</Alert></div> : null}
        {review.error ? <div className="p-4"><Alert>{errorText(review.error)}</Alert></div> : null}
        {list.data?.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('closing.none')}</p> : null}
        {list.data && list.data.length > 0 ? (
          <Table head={[t('attendance.date'), t('vehicles.seller'), t('closing.counts'), t('common.status')]}>
            {list.data.map((d) => (
              <tr key={d.id} data-testid={`closing-${d.seller.name}`}>
                <Cell>{format.date(d.workDate)}<div className="text-xs text-stone-500">{format.dateTime(d.declaredAt)}</div></Cell>
                <Cell>{d.seller.name}<div className="text-xs text-stone-500"><bdi dir="ltr">{d.vehicle.registration}</bdi></div></Cell>
                <Cell>
                  <ul className="space-y-0.5">
                    {d.lines.map((l) => (
                      <li key={l.skuId} className={l.variancePacks !== 0 ? 'font-medium text-red-800' : ''}>
                        <bdi dir="ltr" className="font-mono">{l.code}</bdi>
                        {` · ${t('closing.declaredVsSystem', { declared: l.declaredPacks, system: l.systemPacks })}`}
                      </li>
                    ))}
                  </ul>
                </Cell>
                <Cell>
                  <Badge tone={TONE[d.status]}>{t(`closing.statuses.${d.status}`)}</Badge>
                  {d.reviewComment ? <div className="mt-1 text-xs text-stone-500">{t('closing.reviewedBy', { name: d.reviewedBy ?? '', comment: d.reviewComment })}</div> : null}
                  {d.status === 'VARIANCE_FLAGGED' ? (
                    <form className="mt-2 flex flex-wrap items-end gap-2" noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => {
                      e.preventDefault();
                      review.run({ id: d.id, version: d.version, comment: formText(new FormData(e.currentTarget), 'comment') });
                    }}>
                      <Field id={`cr-${d.id}`} label={t('closing.comment')}><Input id={`cr-${d.id}`} name="comment" maxLength={500} /></Field>
                      <Button type="submit" size="sm" disabled={review.isPending}>{t('closing.markReviewed')}</Button>
                    </form>
                  ) : null}
                </Cell>
              </tr>
            ))}
          </Table>
        ) : null}
      </Card>
    </div>
  );
}
