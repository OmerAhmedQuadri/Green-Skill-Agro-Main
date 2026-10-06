'use client';

import { RETENTION_SETTING, SETTINGS, STORED_KINDS, type RetentionPeriod, type StoredKind } from '@gsa/core';
import type { media } from '@gsa/services';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, Card, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { api } from '@/lib/api';
import { wholeNumber } from '@/lib/forms';
import { useFormat, type Format } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { usePeriodText } from './periods';

type Overview = media.StorageOverview;
type Preview = { runAt: string; due: Record<StoredKind, media.FileCount> };
type Periods = Record<StoredKind, RetentionPeriod>;
type Change = { periods: Partial<Periods>; budgetGb?: number; confirm?: boolean };

/** The choices offered for a period, within the kind's range — and whatever is set now, if it is not one of them. */
const PRESETS = [1, 2, 3, 4, 5, 6, 9, 12, 18, 24, 36, 48, 60, 72, 84, 96, 108, 120];
function choicesFor(kind: StoredKind, current: RetentionPeriod): RetentionPeriod[] {
  const spec = SETTINGS[RETENTION_SETTING[kind]];
  const months = new Set(PRESETS.filter((m) => m >= spec.min && m <= spec.max));
  if (current !== 'FOREVER') months.add(current);
  return [...[...months].sort((a, b) => a - b), ...(spec.forever ? ['FOREVER' as const] : [])];
}

const encode = (p: RetentionPeriod) => String(p);
const decode = (raw: string): RetentionPeriod => (raw === 'FOREVER' ? 'FOREVER' : Number(raw));

/** SYS-010..013 (ADR-0049): the Super Admin's view of what is stored, and how long each kind is kept. */
export function StoragePage() {
  const t = useTranslations('storage');
  const errorText = useErrorText();
  const overview = useQuery({ queryKey: keys.storage, queryFn: () => api<Overview>('/storage') });
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {overview.error ? <Alert>{errorText(overview.error)}</Alert> : null}
      {overview.data ? (
        <>
          <Figures overview={overview.data} />
          <PolicyForm overview={overview.data} />
        </>
      ) : null}
    </div>
  );
}

function Bar({ used, of, label }: { used: number; of: number; label: string }) {
  const share = of > 0 ? Math.min(100, Math.round((used / of) * 100)) : 0;
  return (
    <div className="mt-3 h-2 rounded-full bg-stone-100" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}>
      <div className={`h-2 rounded-full ${used > of ? 'bg-red-600' : share >= 80 ? 'bg-amber-500' : 'bg-brand-700'}`} style={{ inlineSize: `${share}%` }} />
    </div>
  );
}

function Figure({ title, value, children, testId }: { title: string; value: ReactNode; children?: ReactNode; testId: string }) {
  return (
    <Card className="p-5" data-testid={testId}>
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{title}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {children}
    </Card>
  );
}

function Figures({ overview }: { overview: Overview }) {
  const t = useTranslations('storage');
  const format = useFormat();
  const { total, budgetBytes, database, backups, disk } = overview;
  const room = budgetBytes - total.bytes;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Figure testId="storage-files" title={t('files')} value={t('ofBudget', { used: format.bytes(total.bytes), budget: format.bytes(budgetBytes) })}>
        <Bar used={total.bytes} of={budgetBytes} label={t('files')} />
        <p className="mt-2 text-sm text-stone-600">
          {room >= 0 ? t('freeInBudget', { free: format.bytes(room) }) : t('overBudget', { over: format.bytes(-room) })}
        </p>
      </Figure>
      <Figure testId="storage-database" title={t('database')} value={format.bytes(database.bytes)}>
        <p className="mt-2 text-sm text-stone-600">{t('databaseHint')}</p>
      </Figure>
      <Figure testId="storage-backups" title={t('backups')} value={backups ? t('backupsSummary', { count: backups.count, size: format.bytes(backups.bytes) }) : '—'}>
        <p className="mt-2 text-sm text-stone-600">
          {backups ? t('backupsNewest', { time: format.dateTime(backups.newestAt ?? backups.reportedAt) }) : t('noBackups')}
        </p>
      </Figure>
      <Figure testId="storage-disk" title={t('disk')} value={disk ? t('diskSummary', { free: format.bytes(disk.freeBytes), total: format.bytes(disk.totalBytes) }) : '—'}>
        {disk ? <Bar used={disk.totalBytes - disk.freeBytes} of={disk.totalBytes} label={t('disk')} /> : <p className="mt-2 text-sm text-stone-600">{t('diskUnknown')}</p>}
      </Figure>
    </div>
  );
}

const filesSize = (t: ReturnType<typeof useTranslations<'storage'>>, format: Format, c: media.FileCount) =>
  (c.files === 0 ? '—' : t('filesSize', { count: c.files, size: format.bytes(c.bytes) }));

function PolicyForm({ overview }: { overview: Overview }) {
  const t = useTranslations('storage');
  const tc = useTranslations('common');
  const ts = useTranslations('settings');
  const format = useFormat();
  const periodText = usePeriodText();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const current = Object.fromEntries(overview.kinds.map((k) => [k.kind, k.period])) as Periods;
  const [draft, setDraft] = useState<Periods>(current);
  const [budget, setBudget] = useState(String(overview.budgetGb));
  const [pending, setPending] = useState<{ change: Change; files: number; bytes: number; runAt: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  const save = useCommand((body: Change, key) => api<Overview>('/storage', { method: 'PATCH', body, idempotencyKey: key }), {
    onSuccess: (next) => { setPending(null); setSaved(true); queryClient.setQueryData(keys.storage, next); },
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    setProblem(null);
    const periods = Object.fromEntries(STORED_KINDS.filter((k) => draft[k] !== current[k]).map((k) => [k, draft[k]])) as Partial<Periods>;
    const budgetGb = wholeNumber(budget) ?? Number.NaN;
    const change: Change = { periods, ...(budgetGb !== overview.budgetGb ? { budgetGb } : {}) };
    if (Object.keys(periods).length === 0 && change.budgetGb === undefined) return;
    // Shorter periods first show what they would delete at the next run (SYS-012); the server holds the same line.
    setChecking(true);
    try {
      const query = new URLSearchParams(Object.entries(periods).map(([k, v]) => [k, encode(v)]));
      const preview = await api<Preview>(`/storage/preview?${query.toString()}`);
      const more = overview.kinds.filter((k) => preview.due[k.kind].files > k.due.files);
      if (more.length === 0) { save.run(change); return; }
      setPending({
        change: { ...change, confirm: true }, runAt: preview.runAt,
        files: more.reduce((n, k) => n + preview.due[k.kind].files - k.due.files, 0),
        bytes: more.reduce((n, k) => n + preview.due[k.kind].bytes - k.due.bytes, 0),
      });
    } catch (error) {
      setProblem(error);
    } finally {
      setChecking(false);
    }
  };

  const nextDue = overview.kinds.reduce((sum, k) => ({ files: sum.files + k.due.files, bytes: sum.bytes + k.due.bytes }), { files: 0, bytes: 0 });
  return (
    <Section title={t('policy')} description={t('policyHint')}>
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4 pb-5">
        <p className="px-5 pt-4 text-sm text-stone-700" data-testid="storage-next-run">
          {t('nextRun', { time: format.dateTime(overview.nextRunAt) })}{' '}
          {nextDue.files > 0 ? t('nextRunDeletes', { count: nextDue.files, size: format.bytes(nextDue.bytes) }) : t('nextRunNothing')}
        </p>
        <Table head={[t('columns.kind'), t('columns.keepFor'), t('columns.stored'), t('columns.lastMonth'), t('columns.oldest'), t('columns.kept'), t('columns.deleted'), t('columns.due')]}>
          {overview.kinds.map((k) => (
            <tr key={k.kind} data-testid={`storage-row-${k.kind}`}>
              <Cell className="font-medium">{t(`kinds.${k.kind}`)}</Cell>
              <Cell>
                <Select aria-label={t(`kinds.${k.kind}`)} data-testid={`storage-keep-${k.kind}`} value={encode(draft[k.kind])}
                  onChange={(e) => { setPending(null); setDraft({ ...draft, [k.kind]: decode(e.target.value) }); }}>
                  {choicesFor(k.kind, draft[k.kind]).map((p) => <option key={encode(p)} value={encode(p)}>{periodText(p)}</option>)}
                </Select>
                {k.kind === 'SELFIE' ? <p className="mt-1 max-w-56 text-xs text-stone-500">{t('selfieCap')}</p> : null}
                {k.kind === 'DELIVERY_DOCUMENT' ? <p className="mt-1 max-w-56 text-xs text-stone-500">{t('documentHint')}</p> : null}
              </Cell>
              <Cell className="whitespace-nowrap">{filesSize(t, format, k)}</Cell>
              <Cell className="whitespace-nowrap">{filesSize(t, format, k.added)}</Cell>
              <Cell className="whitespace-nowrap">{k.oldest ? format.dateTime(k.oldest) : '—'}</Cell>
              <Cell>{k.kept === 0 ? '—' : format.number(k.kept)}</Cell>
              <Cell className="whitespace-nowrap">{filesSize(t, format, k.deleted)}</Cell>
              <Cell className="whitespace-nowrap" data-testid={`storage-due-${k.kind}`}>{filesSize(t, format, k.due)}</Cell>
            </tr>
          ))}
        </Table>
        <div className="px-5">
          <Field id="storage-budget" label={ts('fields.storage.budget_gb')} hint={t('budgetHint')}>
            <Input id="storage-budget" dir="ltr" inputMode="numeric" type="number" min={1} max={10000} className="max-w-40"
              value={budget} onChange={(e) => { setPending(null); setBudget(e.target.value); }} />
          </Field>
        </div>
        <div className="space-y-3 px-5">
          {save.error ? <Alert>{errorText(save.error)}</Alert> : null}
          {problem ? <Alert>{errorText(problem)}</Alert> : null}
          {saved ? <Alert tone="success">{tc('saved')}</Alert> : null}
          {pending ? (
            <Alert tone="warning" data-testid="storage-confirm">
              <p className="font-semibold">{t('confirmTitle')}</p>
              <p className="mt-1">{t('confirmBody', { count: pending.files, size: format.bytes(pending.bytes), time: format.dateTime(pending.runAt) })}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" variant="danger" disabled={save.isPending} onClick={() => save.run(pending.change)}>{t('confirm')}</Button>
                <Button type="button" variant="secondary" onClick={() => setPending(null)}>{tc('cancel')}</Button>
              </div>
            </Alert>
          ) : (
            <Button type="submit" disabled={save.isPending || checking}>{save.isPending ? tc('saving') : t('save')}</Button>
          )}
        </div>
      </form>
    </Section>
  );
}
