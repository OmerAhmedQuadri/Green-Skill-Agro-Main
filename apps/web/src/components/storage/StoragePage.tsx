'use client';

import {
  addDays, businessDate, isBackupNote, RETENTION_SETTING, SETTINGS, STORED_KINDS, type RetentionPeriod, type StoredKind,
} from '@gsa/core';
import type { media, system } from '@gsa/services';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@gsa/ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Facts, Section } from '@/components/common/Section';
import { Cell, Table } from '@/components/common/Table';
import { Tabs } from '@/components/common/Tabs';
import { api } from '@/lib/api';
import { wholeNumber } from '@/lib/forms';
import { useFormat, type Format } from '@/lib/format';
import { useCommand, useErrorText } from '@/lib/hooks';
import { keys } from '@/lib/query-keys';
import { usePeriodText } from './periods';

type Overview = media.StorageOverview;
type FileCount = media.FileCount;
type Preview = { runAt: string; due: Record<StoredKind, FileCount>; backups: FileCount | null };
type Periods = Record<StoredKind, RetentionPeriod>;
type Change = { periods?: Partial<Periods>; budgetGb?: number; backupRetentionDays?: number; confirm?: boolean };

const TABS = ['media', 'backups', 'server'] as const;
type Tab = (typeof TABS)[number];

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

/** Saving a storage change; the page's copy of the overview is replaced by the server's answer. */
function useSave(onSaved: () => void) {
  const queryClient = useQueryClient();
  return useCommand((body: Change, key) => api<Overview>('/storage', { method: 'PATCH', body, idempotencyKey: key }), {
    onSuccess: (next) => { queryClient.setQueryData(keys.storage, next); onSaved(); },
  });
}

/**
 * SYS-010..013 (ADR-0049, amended): the Super Admin's view of storage. Both
 * R2 buckets together against the budget on top, then a tab each for the
 * media bucket, the backups bucket and the server.
 */
export function StoragePage() {
  const t = useTranslations('storage');
  const errorText = useErrorText();
  const [tab, setTab] = useState<Tab>('media');
  const overview = useQuery({
    queryKey: keys.storage, queryFn: () => api<Overview>('/storage'),
    // While a backup is asked for or running, follow it until it ends.
    refetchInterval: (query) => (query.state.data?.backupRuns.some((r) => r.status === 'REQUESTED' || r.status === 'RUNNING') ? 5_000 : false),
  });
  const data = overview.data;
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {overview.error ? <Alert>{errorText(overview.error)}</Alert> : null}
      {data ? (
        <>
          <R2Total overview={data} />
          <Tabs id="storage" label={t('tabs.label')} tabs={TABS.map((key) => ({ key, label: t(`tabs.${key}`) }))} active={tab} onChange={setTab}>
            {tab === 'media' ? <MediaTab overview={data} /> : tab === 'backups' ? <BackupsTab overview={data} /> : <ServerTab overview={data} />}
          </Tabs>
        </>
      ) : null}
    </div>
  );
}

/** A bar of one or more parts against a whole, filling from the start edge in either language. */
function Bar({ parts, of, label }: { parts: readonly { bytes: number; tone: string }[]; of: number; label: string }) {
  const used = parts.reduce((n, p) => n + p.bytes, 0);
  const share = (bytes: number) => (of > 0 ? Math.min(100, (bytes / of) * 100) : 0);
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-stone-100" role="meter" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share(used))}>
      {parts.map((p, i) => <div key={i} className={used > of ? 'bg-red-600' : p.tone} style={{ inlineSize: `${share(p.bytes)}%` }} />)}
    </div>
  );
}

const Swatch = ({ tone }: { tone: string }) => <span aria-hidden className={`me-1.5 inline-block size-2.5 rounded-sm align-middle ${tone}`} />;
const MEDIA_TONE = 'bg-brand-700';
const BACKUPS_TONE = 'bg-sky-600';

/** What Cloudflare bills: both buckets together, against the budget the Super Admin sets. */
function R2Total({ overview }: { overview: Overview }) {
  const t = useTranslations('storage');
  const ts = useTranslations('settings');
  const tc = useTranslations('common');
  const format = useFormat();
  const errorText = useErrorText();
  const [budget, setBudget] = useState(String(overview.budgetGb));
  const [saved, setSaved] = useState(false);
  const save = useSave(() => setSaved(true));
  const { r2Bytes, budgetBytes, media: files, backups } = overview;
  const room = budgetBytes - r2Bytes;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    const budgetGb = wholeNumber(budget) ?? Number.NaN;
    if (budgetGb !== overview.budgetGb) save.run({ budgetGb });
  };
  return (
    <Card className="space-y-3 p-5" data-testid="storage-r2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{t('r2.title')}</p>
        <p className="text-xl font-semibold">{t('ofBudget', { used: format.bytes(r2Bytes), budget: format.bytes(budgetBytes) })}</p>
      </div>
      <Bar of={budgetBytes} label={t('r2.title')} parts={[{ bytes: files.bytes, tone: MEDIA_TONE }, { bytes: backups?.bytes ?? 0, tone: BACKUPS_TONE }]} />
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-stone-600">
        <span><Swatch tone={MEDIA_TONE} />{t('r2.media', { size: format.bytes(files.bytes) })}</span>
        <span>
          <Swatch tone={BACKUPS_TONE} />
          {backups ? t('r2.backups', { size: format.bytes(backups.bytes) }) : overview.backupsOn ? t('r2.backupsUnknown') : t('r2.backupsOff')}
        </span>
        <span>{room >= 0 ? t('freeInBudget', { free: format.bytes(room) }) : t('overBudget', { over: format.bytes(-room) })}</span>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-3 border-t border-stone-100 pt-3">
        <Field id="storage-budget" label={ts('fields.storage.budget_gb')}>
          <Input id="storage-budget" dir="ltr" inputMode="numeric" type="number" min={1} max={10000} className="max-w-40"
            value={budget} onChange={(e) => { setSaved(false); setBudget(e.target.value); }} />
        </Field>
        <Button type="submit" variant="secondary" disabled={save.isPending}>{save.isPending ? tc('saving') : tc('save')}</Button>
        {saved ? <span className="self-center text-sm text-brand-800">{tc('saved')}</span> : null}
        <p className="w-full text-xs text-stone-500">{t('budgetHint')}</p>
        {save.error ? <Alert className="w-full">{errorText(save.error)}</Alert> : null}
      </form>
    </Card>
  );
}

const filesSize = (t: ReturnType<typeof useTranslations<'storage'>>, format: Format, c: FileCount) =>
  (c.files === 0 ? '—' : t('filesSize', { count: c.files, size: format.bytes(c.bytes) }));

/** A tab's description: the bucket's name where it is known, then what it holds. */
function BucketHint({ bucket, hint }: { bucket: string | null; hint: string }) {
  const t = useTranslations('storage');
  if (!bucket) return <>{hint}</>;
  return <><span className="font-medium text-stone-700">{t('bucketLabel')} <bdi dir="ltr">{bucket}</bdi></span>{' · '}{hint}</>;
}

/** The confirmation every deleting change waits on (SYS-012). */
function Confirm({ title, body, pending, onConfirm, onCancel }: { title: string; body: ReactNode; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  const t = useTranslations('storage');
  const tc = useTranslations('common');
  return (
    <Alert tone="warning" data-testid="storage-confirm">
      <p className="font-semibold">{title}</p>
      <p className="mt-1">{body}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="danger" disabled={pending} onClick={onConfirm}>{t('confirm')}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>{tc('cancel')}</Button>
      </div>
    </Alert>
  );
}

/** The media bucket: each kind's period, and what each kind holds (SYS-010, SYS-013). */
function MediaTab({ overview }: { overview: Overview }) {
  const t = useTranslations('storage');
  const tc = useTranslations('common');
  const format = useFormat();
  const periodText = usePeriodText();
  const errorText = useErrorText();
  const current = Object.fromEntries(overview.kinds.map((k) => [k.kind, k.period])) as Periods;
  const [draft, setDraft] = useState<Periods>(current);
  const [pending, setPending] = useState<{ change: Change; files: number; bytes: number; runAt: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const save = useSave(() => { setPending(null); setSaved(true); });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    setProblem(null);
    const periods = Object.fromEntries(STORED_KINDS.filter((k) => draft[k] !== current[k]).map((k) => [k, draft[k]])) as Partial<Periods>;
    if (Object.keys(periods).length === 0) return;
    // A shorter period first shows what the next clean-up would delete (SYS-012); the server holds the same line.
    setChecking(true);
    try {
      const query = new URLSearchParams(Object.entries(periods).map(([k, v]) => [k, encode(v)]));
      const preview = await api<Preview>(`/storage/preview?${query.toString()}`);
      const more = overview.kinds.filter((k) => preview.due[k.kind].files > k.due.files);
      if (more.length === 0) { save.run({ periods }); return; }
      setPending({
        change: { periods, confirm: true }, runAt: preview.runAt,
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
    <Section title={t('media.title')} description={<BucketHint bucket={overview.media.bucket} hint={t('media.hint')} />}>
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4 pb-5">
        <p className="px-5 pt-4 text-sm text-stone-700" data-testid="storage-next-run">
          {t('nextRun', { time: format.dateTime(overview.nextRunAt) })}{' '}
          {nextDue.files > 0 ? t('nextRunDeletes', { count: nextDue.files, size: format.bytes(nextDue.bytes) }) : t('nextRunNothing')}
        </p>
        <p className="px-5 text-sm text-stone-600">{t('policyHint')}</p>
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
        <div className="space-y-3 px-5">
          {save.error ? <Alert>{errorText(save.error)}</Alert> : null}
          {problem ? <Alert>{errorText(problem)}</Alert> : null}
          {saved ? <Alert tone="success">{tc('saved')}</Alert> : null}
          {pending ? (
            <Confirm title={t('confirmTitle')} pending={save.isPending} onConfirm={() => save.run(pending.change)} onCancel={() => setPending(null)}
              body={t('confirmBody', { count: pending.files, size: format.bytes(pending.bytes), time: format.dateTime(pending.runAt) })} />
          ) : (
            <Button type="submit" disabled={save.isPending || checking}>{save.isPending ? tc('saving') : t('save')}</Button>
          )}
        </div>
      </form>
    </Section>
  );
}

const RUN_TONE = { REQUESTED: 'warning', RUNNING: 'warning', SUCCEEDED: 'success', FAILED: 'danger', SKIPPED: 'neutral' } as const;
const PAUSE_NIGHTS = [1, 3, 7, 14, 30];

/**
 * ADR-0050: the nightly backup — paused for a while, or not — a backup now,
 * and how the latest runs went, failures included.
 */
function BackupControls({ overview }: { overview: Overview }) {
  const t = useTranslations('storage.backups');
  const format = useFormat();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [nights, setNights] = useState(String(PAUSE_NIGHTS[0]));
  const onSuccess = (next: Overview) => { queryClient.setQueryData(keys.storage, next); };
  const backUp = useCommand((_: null, key) => api<Overview>('/storage/backups', { method: 'POST', body: {}, idempotencyKey: key }), { onSuccess });
  const pause = useCommand((until: string | null, key) => api<Overview>('/storage/backups/pause', { method: 'PUT', body: { until }, idempotencyKey: key }), { onSuccess });
  const active = overview.backupRuns.find((r) => r.status === 'REQUESTED' || r.status === 'RUNNING');
  const { backups, backupsPausedUntil: pausedUntil } = overview;

  return (
    <div className="space-y-3 px-5 pt-4" data-testid="backup-controls">
      {pausedUntil ? (
        <Alert tone="warning" data-testid="backups-paused">
          <p>{t('paused', { date: format.date(pausedUntil) })}</p>
          <Button className="mt-2" size="sm" variant="secondary" disabled={pause.isPending} onClick={() => pause.run(null)}>{t('resume')}</Button>
        </Alert>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <p className="w-full text-sm text-stone-700">{t('nightly')}</p>
          <Field id="backup-pause-nights" label={t('pauseFor')}>
            <Select id="backup-pause-nights" value={nights} onChange={(e) => setNights(e.target.value)}>
              {PAUSE_NIGHTS.map((n) => <option key={n} value={n}>{t('nights', { count: n })}</option>)}
            </Select>
          </Field>
          <Button variant="secondary" disabled={pause.isPending}
            onClick={() => pause.run(addDays(businessDate(new Date()), Number(nights)))}>{t('pause')}</Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={Boolean(active) || backUp.isPending} onClick={() => backUp.run(null)}>{t('backUpNow')}</Button>
        {active ? (
          <span className="text-sm text-stone-600" data-testid="backup-active">
            {active.status === 'REQUESTED' ? t('requested', { time: format.dateTime(active.requestedAt) }) : t('running', { time: format.dateTime(active.startedAt ?? active.requestedAt) })}
          </span>
        ) : null}
      </div>
      {backUp.error ? <Alert>{errorText(backUp.error)}</Alert> : null}
      {pause.error ? <Alert>{errorText(pause.error)}</Alert> : null}
      {backups?.stale ? <Alert tone="warning" data-testid="backups-stale">{t('stale', { time: format.dateTime(backups.newestAt ?? backups.reportedAt) })}</Alert> : null}
      <BackupRuns runs={overview.backupRuns} />
    </div>
  );
}

function BackupRuns({ runs }: { runs: readonly system.BackupRun[] }) {
  const t = useTranslations('storage.backups');
  const format = useFormat();
  if (runs.length === 0) return <p className="text-sm text-stone-600">{t('noRuns')}</p>;
  return (
    <div className="space-y-2" data-testid="backup-runs">
      <p className="text-sm font-semibold text-stone-900">{t('runs')}</p>
      <Table head={[t('runWhen'), t('runHow'), t('runResult')]}>
        {runs.map((r) => (
          <tr key={r.id}>
            <Cell className="whitespace-nowrap">{format.dateTime(r.requestedAt)}</Cell>
            <Cell>{r.trigger === 'NIGHTLY' ? t('nightlyRun') : t('manualRun', { name: r.requestedBy ?? '—' })}</Cell>
            <Cell>
              <Badge tone={RUN_TONE[r.status]}>{t(`runStatus.${r.status}`)}</Badge>
              {r.note ? <span className="ms-2 text-sm text-stone-600">{isBackupNote(r.note) ? t(`notes.${r.note}`) : <bdi dir="ltr">{r.note}</bdi>}</span> : null}
            </Cell>
          </tr>
        ))}
      </Table>
    </div>
  );
}

/** The backups bucket, as the nightly backup last reported it, and how long backups are kept (ADR-0049, amended). */
function BackupsTab({ overview }: { overview: Overview }) {
  const t = useTranslations('storage');
  const tc = useTranslations('common');
  const format = useFormat();
  const errorText = useErrorText();
  const { backups, backupsOn, backupRetentionDays: current } = overview;
  const [days, setDays] = useState(String(current));
  const [pending, setPending] = useState<{ days: number; removes: FileCount | null } | null>(null);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const save = useSave(() => { setPending(null); setSaved(true); });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    setProblem(null);
    const next = wholeNumber(days) ?? Number.NaN;
    if (next === current) return;
    // Longer, or not a number at all (the server says why): straight to the server. Shorter always asks first.
    if (!(next < current)) { save.run({ backupRetentionDays: next }); return; }
    try {
      const preview = await api<Preview>(`/storage/preview?${new URLSearchParams({ backupRetentionDays: String(next) }).toString()}`);
      const removes = preview.backups && backups ? { files: preview.backups.files - backups.due.files, bytes: preview.backups.bytes - backups.due.bytes } : null;
      setPending({ days: next, removes });
    } catch (error) {
      setProblem(error);
    }
  };

  return (
    <Section title={t('backups.title')} description={<BucketHint bucket={backups?.bucket ?? null} hint={t('backups.hint')} />}>
      <div className="space-y-4 pb-5" data-testid="storage-backups">
        {backupsOn ? <BackupControls overview={overview} /> : null}
        {backups ? (
          <>
            {backupsOn ? null : <div className="px-5 pt-4"><Alert tone="warning" data-testid="backups-off">{t('backups.offWithReport')}</Alert></div>}
            <Facts items={[
              { label: t('backups.copies'), value: format.number(backups.count) },
              { label: t('backups.size'), value: format.bytes(backups.bytes) },
              { label: t('backups.newest'), value: backups.newestAt ? format.dateTime(backups.newestAt) : '—' },
              { label: t('backups.oldest'), value: backups.oldestAt ? format.dateTime(backups.oldestAt) : '—' },
            ]} />
            <p className="px-5 text-sm text-stone-700">
              {t('backups.reported', { time: format.dateTime(backups.reportedAt) })}{' '}
              {backups.due.files > 0
                ? t('backups.due', { count: backups.due.files, size: format.bytes(backups.due.bytes), days: current })
                : t('backups.nothingDue')}
            </p>
          </>
        ) : (
          // A server without the backup settings takes none: say so, rather than promise one that will never come.
          <div className="px-5 pt-4">
            {backupsOn
              ? <Alert tone="info">{t('backups.noReport')}</Alert>
              : <Alert tone="info" data-testid="backups-off">{t('backups.off')}</Alert>}
          </div>
        )}
        <form onSubmit={(e) => void submit(e)} noValidate className="space-y-3 px-5">
          <Field id="storage-backup-days" label={t('backups.keepFor')} hint={t('backups.keepHint')}>
            <Input id="storage-backup-days" dir="ltr" inputMode="numeric" type="number" min={7} max={3650} className="max-w-40"
              value={days} onChange={(e) => { setPending(null); setSaved(false); setDays(e.target.value); }} />
          </Field>
          {save.error ? <Alert>{errorText(save.error)}</Alert> : null}
          {problem ? <Alert>{errorText(problem)}</Alert> : null}
          {saved ? <Alert tone="success">{tc('saved')}</Alert> : null}
          {pending ? (
            <Confirm title={t('backups.confirmTitle')} pending={save.isPending}
              onConfirm={() => save.run({ backupRetentionDays: pending.days, confirm: true })} onCancel={() => setPending(null)}
              body={pending.removes
                ? t('backups.confirmBody', { count: pending.removes.files, size: format.bytes(pending.removes.bytes), days: pending.days })
                : t('backups.confirmUnknown', { days: pending.days })} />
          ) : (
            <Button type="submit" disabled={save.isPending}>{save.isPending ? tc('saving') : tc('save')}</Button>
          )}
        </form>
      </div>
    </Section>
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

/** This server: the database every record lives in, and the disk under it. */
function ServerTab({ overview }: { overview: Overview }) {
  const t = useTranslations('storage');
  const format = useFormat();
  const { database, disk } = overview;
  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-600">{t('server.hint')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Figure testId="storage-database" title={t('database')} value={format.bytes(database.bytes)}>
          <p className="mt-2 text-sm text-stone-600">{t('databaseHint')}</p>
        </Figure>
        <Figure testId="storage-disk" title={t('disk')} value={disk ? t('diskSummary', { free: format.bytes(disk.freeBytes), total: format.bytes(disk.totalBytes) }) : '—'}>
          {disk
            ? <div className="mt-3"><Bar of={disk.totalBytes} label={t('disk')} parts={[{ bytes: disk.totalBytes - disk.freeBytes, tone: MEDIA_TONE }]} /></div>
            : <p className="mt-2 text-sm text-stone-600">{t('diskUnknown')}</p>}
        </Figure>
      </div>
    </div>
  );
}
