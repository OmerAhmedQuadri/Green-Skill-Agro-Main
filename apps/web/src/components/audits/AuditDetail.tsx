'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Cell, Table } from '@/components/common/Table';
import { Section } from '@/components/common/Section';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { wholeNumber } from '@/lib/forms';
import { useErrorText, useOnceCommand } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import type { VehicleAudit } from './types';

type Counts = Record<string, { packs: string; comment: string }>;

/**
 * Workflow N (VEH-011..013, OQ-022): the manager enters what they counted,
 * batch by batch, against the system's figure. Every difference needs a
 * comment before the audit can close. Closing raises a write-off for each
 * shortfall, and a surplus waits for another manager to approve it.
 */
export function AuditDetail({ id, canDecideSurplus }: { id: string; canDecideSurplus: boolean }) {
  const t = useTranslations('audits');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [counts, setCounts] = useState<Counts>({});
  const [comment, setComment] = useState('');
  const audit = useQuery({ queryKey: keys.audit(id), queryFn: () => api<VehicleAudit>(`/vehicle-audits/${id}`) });
  const refresh = (a: VehicleAudit) => {
    queryClient.setQueryData(keys.audit(id), a);
    for (const k of [keys.audits(), keys.dashboardFlags]) void queryClient.invalidateQueries({ queryKey: k });
  };
  const act = useOnceCommand((body: { action: string; data: unknown }, key) =>
    api<VehicleAudit>(`/vehicle-audits/${id}/${body.action}`, { method: 'POST', body: body.data, idempotencyKey: key }), { onSuccess: refresh });

  if (audit.isPending) return <p className="text-sm text-stone-500">{t('loading')}</p>;
  if (audit.error) return <Alert>{errorText(audit.error)}</Alert>;
  const a = audit.data;
  const open = a.status === 'IN_PROGRESS';
  const countOf = (lineId: string, counted: number | null, lineComment: string | null) =>
    counts[lineId] ?? { packs: counted === null ? '' : String(counted), comment: lineComment ?? '' };
  const set = (lineId: string, counted: number | null, lineComment: string | null, field: 'packs' | 'comment', value: string) =>
    setCounts({ ...counts, [lineId]: { ...countOf(lineId, counted, lineComment), [field]: value } });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('title', { registration: a.vehicle.registration })}
        subtitle={<bdi dir="ltr">{a.number}</bdi>}
        back={{ href: '/console/audits', label: t('listTitle') }}
        actions={<Badge tone={open ? 'warning' : 'success'} data-testid="audit-status">{t(`statuses.${a.status}`)}</Badge>}
      />
      <Card className="space-y-1 p-4 text-sm">
        <div>{t('openedBy', { name: a.openedBy.name, time: format.dateTime(a.openedAt) })}</div>
        {a.seller ? <div>{t('seller', { name: a.seller.name })}</div> : <div>{t('noSeller')}</div>}
        {a.closedBy && a.closedAt ? <div>{t('closedBy', { name: a.closedBy.name, time: format.dateTime(a.closedAt) })}</div> : null}
      </Card>

      {a.remoteConfirmations.length > 0 ? (
        <Section title={t('remoteTitle')}>
          <div className="p-5 text-sm">
            <p className="mb-2 text-stone-600">{t('remoteHint')}</p>
            <ul className="space-y-1">
              {a.remoteConfirmations.map((r) => (
                <li key={r.id} data-testid={`remote-${r.number}`}>
                  <bdi dir="ltr">{r.number}</bdi>{` · ${r.store} · ${format.dateTime(r.confirmedAt)}`}
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ) : null}

      <Section title={t('linesTitle')}>
        <Table head={[t('item'), t('batch'), t('system'), t('counted'), t('comment'), t('outcomeHead')]}>
          {a.lines.map((l) => {
            const c = countOf(l.id, l.countedPacks, l.comment);
            return (
              <tr key={l.id} data-testid={`audit-line-${l.code}`}>
                <Cell>
                  <div className="font-medium">{format.name(l.product)}{l.variety ? ` — ${format.name(l.variety)}` : ''}</div>
                  <div className="text-xs text-stone-500"><bdi dir="ltr">{l.code}</bdi></div>
                </Cell>
                <Cell><span className="text-xs">{t('lotExpiry', { lot: l.lotNumber ?? '—', expiry: l.expiresOn ? format.date(l.expiresOn) : '—' })}</span></Cell>
                <Cell>{format.number(l.expectedPacks)}</Cell>
                <Cell>
                  {open ? (
                    <Input aria-label={t('countedFor', { code: l.code, lot: l.lotNumber ?? '—' })} inputMode="numeric" dir="ltr" className="w-24"
                      value={c.packs} onChange={(e) => set(l.id, l.countedPacks, l.comment, 'packs', e.target.value)} />
                  ) : format.number(l.countedPacks ?? 0)}
                </Cell>
                <Cell>
                  {open ? (
                    <Input aria-label={t('commentFor', { code: l.code, lot: l.lotNumber ?? '—' })} className="w-56"
                      value={c.comment} onChange={(e) => set(l.id, l.countedPacks, l.comment, 'comment', e.target.value)} />
                  ) : l.comment ?? '—'}
                </Cell>
                <Cell>
                  {l.outcome ? <Badge tone={l.outcome === 'MATCH' ? 'success' : l.outcome === 'SHORTFALL' ? 'danger' : 'warning'}>{t(`outcomes.${l.outcome}`)}</Badge> : '—'}
                  {l.writeOffNumber ? <div className="text-xs text-stone-500">{t('writeOffRaised', { number: l.writeOffNumber })}</div> : null}
                  {l.surplus ? (
                    <div className="text-xs text-stone-500" data-testid={`surplus-${l.code}`}>
                      {t(`surplusStatuses.${l.surplus.status}`)}
                      {l.surplus.decidedBy ? ` · ${l.surplus.decidedBy.name}` : ''}
                    </div>
                  ) : null}
                </Cell>
              </tr>
            );
          })}
        </Table>
      </Section>

      {act.error ? <Alert>{errorText(act.error)}</Alert> : null}

      {open ? (
        <Card className="space-y-3 p-4">
          <Field id="note" label={t('note')}><Input id="note" value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} /></Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={act.isPending} onClick={() => act.run({
              action: 'count',
              data: {
                version: a.version,
                lines: a.lines.map((l) => {
                  const c = countOf(l.id, l.countedPacks, l.comment);
                  return { batchId: l.batchId, packs: wholeNumber(c.packs) ?? -1, comment: c.comment.trim() || null };
                }).filter((l) => l.packs >= 0),
              },
            })}>{t('saveCount')}</Button>
            <Button disabled={act.isPending} onClick={() => act.run({ action: 'close', data: { version: a.version, note: comment.trim() || null } })}>{t('close')}</Button>
          </div>
          <p className="text-sm text-stone-600">{t('closeHint')}</p>
        </Card>
      ) : null}

      {/* OQ-022: found stock is added only once another manager approves it. */}
      {canDecideSurplus && a.lines.some((l) => l.surplus?.status === 'PENDING') ? (
        <Section title={t('surplusTitle')}>
          <div className="space-y-3 p-5">
            <p className="text-sm text-stone-600">{t('surplusHint')}</p>
            <Field id="surplus-comment" label={t('comment')}><Input id="surplus-comment" value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} /></Field>
            {a.lines.filter((l) => l.surplus?.status === 'PENDING').map((l) => (
              <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-3 text-sm">
                <span>{t('surplusLine', { code: l.code, packs: (l.countedPacks ?? 0) - l.expectedPacks })}</span>
                <span className="flex gap-2">
                  <Button disabled={act.isPending} data-testid={`approve-surplus-${l.code}`}
                    onClick={() => act.run({ action: 'surplus', data: { lineId: l.id, approve: true, comment: comment.trim() || null } })}>{t('approveSurplus')}</Button>
                  <Button variant="danger" disabled={act.isPending}
                    onClick={() => act.run({ action: 'surplus', data: { lineId: l.id, approve: false, comment: comment.trim() || null } })}>{t('rejectSurplus')}</Button>
                </span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
