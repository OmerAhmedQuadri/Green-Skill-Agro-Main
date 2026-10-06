import { loadConfig } from '@gsa/config';
import {
  assertPauseUntil, BACKUP_MANUAL_GAP_MS, backupsPausedOn, backupsSwitchedOn, businessDate, DomainError, type BackupNote, type StoredBackup,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { audit, inTx, mapUniqueViolations, violatedConstraint, writeAudit, type Executor } from '../platform';
import { defaultBranchId, getDb } from '../runtime';
import { readSettings, writeSettings } from './settings';

const { auditLog, backupRuns, users } = schema;

/**
 * The nightly backup's word to the storage page (ADR-0049): which bucket, the
 * period it kept to, and the copies left. It goes to the audit log, so the web
 * app never needs the backups bucket's token.
 */
export type BackupReport = {
  readonly bucket: string;
  /** The period this run kept to; null when it could not read one and so removed nothing. */
  readonly days: number | null;
  readonly copies: readonly StoredBackup[];
};

export type LastBackupReport = {
  readonly bucket: string | null;
  readonly days: number | null;
  readonly copies: readonly StoredBackup[];
  readonly count: number;
  readonly bytes: number;
  readonly newestAt: Date | null;
  readonly oldestAt: Date | null;
  readonly reportedAt: Date;
};

/** How long the nightly backup keeps backups: the Super Admin's setting, not `.env` (ADR-0049). */
export async function backupRetentionDays(db: Executor = getDb()): Promise<number> {
  return (await readSettings(db))['storage.backup_retention_days'];
}

export async function reportBackups(report: BackupReport, db: Executor = getDb()): Promise<void> {
  const copies = [...report.copies].sort((a, b) => a.modified.getTime() - b.modified.getTime());
  await writeAudit(db, { actorId: null, branchId: await defaultBranchId(), requestId: 'backup', ip: null }, {
    action: 'backup.completed', entityType: 'backup', entityId: copies.at(-1)?.key ?? null,
    after: {
      bucket: report.bucket, days: report.days,
      count: copies.length, bytes: copies.reduce((n, b) => n + (b.size ?? 0), 0),
      newest: copies.at(-1)?.modified.toISOString() ?? null, oldest: copies[0]?.modified.toISOString() ?? null,
      copies: copies.map((b) => ({ key: b.key, modified: b.modified.toISOString(), size: b.size ?? null })),
    },
  });
}

const text = (v: unknown) => (typeof v === 'string' ? v : null);
const whole = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const instant = (v: unknown) => { const t = text(v); return t && !Number.isNaN(Date.parse(t)) ? new Date(t) : null; };

/** The latest report, read defensively: a report from before the bucket and copies were added still reads. */
export async function lastBackupReport(db: Executor = getDb()): Promise<LastBackupReport | null> {
  const [row] = await db.select({ after: auditLog.after, at: auditLog.occurredAt }).from(auditLog)
    .where(and(eq(auditLog.entityType, 'backup'), eq(auditLog.action, 'backup.completed')))
    .orderBy(desc(auditLog.occurredAt)).limit(1);
  if (!row) return null;
  const r = (row.after ?? {}) as Record<string, unknown>;
  const copies = (Array.isArray(r.copies) ? (r.copies as unknown[]) : []).flatMap((c): StoredBackup[] => {
    const entry = (c ?? {}) as Record<string, unknown>;
    const key = text(entry.key);
    const modified = instant(entry.modified);
    return key && modified ? [{ key, modified, size: whole(entry.size) ?? undefined }] : [];
  });
  return {
    bucket: text(r.bucket), days: whole(r.days), copies,
    count: whole(r.count) ?? copies.length,
    bytes: whole(r.bytes) ?? copies.reduce((n, b) => n + (b.size ?? 0), 0),
    newestAt: instant(r.newest), oldestAt: instant(r.oldest), reportedAt: row.at,
  };
}

/** Whether this server takes backups at all: the three backup settings are in its `.env` (ADR-0050). */
export function backupsOn(): boolean {
  const c = loadConfig();
  return backupsSwitchedOn({ bucket: c.BACKUP_S3_BUCKET, accessKey: c.BACKUP_S3_ACCESS_KEY, secretKey: c.BACKUP_S3_SECRET_KEY });
}

export type BackupRunStatus = 'REQUESTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
export type BackupRun = {
  readonly id: string;
  readonly trigger: 'NIGHTLY' | 'MANUAL';
  readonly status: BackupRunStatus;
  /** Who asked for it; null for the nightly one. */
  readonly requestedBy: string | null;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly note: string | null;
};

/**
 * What takes a backup. On the server, the worker passes in one that runs
 * `deploy/backup.sh` in a process of its own: the database owner's dump inside
 * the database container, then R2 — nothing the worker itself holds or does.
 */
export type BackupRunner = () => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;

/** Past the worker's hour for a backup, a run still RUNNING died with it — a restart, a crash. */
const STUCK_AFTER_MS = 70 * 60_000;

async function releaseStuck(db: Executor, now: Date): Promise<void> {
  await db.update(backupRuns).set({ status: 'FAILED', finishedAt: now, note: 'STOPPED' })
    .where(and(eq(backupRuns.status, 'RUNNING'), lt(backupRuns.startedAt, new Date(now.getTime() - STUCK_AFTER_MS))));
}

/** The runner never throws as far as its caller is concerned: a failure is an outcome to record. */
async function attempt(runner: BackupRunner): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  try {
    return await runner();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const toRun = (r: typeof backupRuns.$inferSelect, requestedBy: string | null = null): BackupRun => ({
  id: r.id, trigger: r.trigger, status: r.status, requestedBy, requestedAt: r.requestedAt,
  startedAt: r.startedAt, finishedAt: r.finishedAt, note: r.note,
});

async function finish(db: Executor, id: string, runner: BackupRunner): Promise<BackupRun> {
  const result = await attempt(runner);
  const [row] = await db.update(backupRuns)
    .set(result.ok ? { status: 'SUCCEEDED', finishedAt: new Date() } : { status: 'FAILED', finishedAt: new Date(), note: result.error.slice(0, 500) })
    .where(eq(backupRuns.id, id)).returning();
  if (!row) throw new Error(`backup run ${id} vanished`);
  return toRun(row);
}

async function skip(db: Executor, now: Date, note: BackupNote): Promise<BackupRun> {
  const [row] = await db.insert(backupRuns).values({ id: newId(), trigger: 'NIGHTLY', status: 'SKIPPED', requestedAt: now, note }).returning();
  if (!row) throw new Error('the skipped backup was not recorded');
  return toRun(row);
}

/**
 * ADR-0050: the Super Admin asks for a backup now. The worker takes it up
 * within seconds. One at a time, and not within ten minutes of the last one
 * taken — a failed one can be retried straight away.
 */
export async function requestBackup(ctx: Ctx): Promise<void> {
  authorize(ctx, 'system.manage_storage');
  if (!backupsOn()) throw new DomainError('BACKUPS_OFF');
  await inTx(ctx, async (tx) => {
    await releaseStuck(tx, ctx.now);
    const [last] = await tx.select({ status: backupRuns.status, finishedAt: backupRuns.finishedAt }).from(backupRuns)
      .where(inArray(backupRuns.status, ['REQUESTED', 'RUNNING', 'SUCCEEDED'])).orderBy(desc(backupRuns.requestedAt)).limit(1);
    if (last?.status === 'REQUESTED' || last?.status === 'RUNNING') throw new DomainError('BACKUP_IN_PROGRESS');
    if (last?.finishedAt && ctx.now.getTime() - last.finishedAt.getTime() < BACKUP_MANUAL_GAP_MS) {
      throw new DomainError('BACKUP_TOO_SOON', { retryAt: new Date(last.finishedAt.getTime() + BACKUP_MANUAL_GAP_MS).toISOString() });
    }
    await mapUniqueViolations(
      tx.insert(backupRuns).values({ id: newId(), trigger: 'MANUAL', status: 'REQUESTED', requestedBy: ctx.user.id, requestedAt: ctx.now }),
      { backup_runs_one_active: new DomainError('BACKUP_IN_PROGRESS') },
    );
    await audit(tx, ctx, { action: 'backup.requested', entityType: 'backup', entityId: null });
  });
}

/** The worker, every few seconds: run the backup somebody asked for, if there is one. */
export async function serveBackupRequest(runner: BackupRunner, now: Date = new Date()): Promise<BackupRun | null> {
  const db = getDb();
  await releaseStuck(db, now);
  const [claimed] = await db.update(backupRuns).set({ status: 'RUNNING', startedAt: now })
    .where(eq(backupRuns.status, 'REQUESTED')).returning();
  return claimed ? finish(db, claimed.id, runner) : null;
}

/** The worker, at 05:00 Riyadh: the nightly backup — skipped, and recorded as such, while paused or while another runs. */
export async function runNightlyBackup(runner: BackupRunner, now: Date = new Date()): Promise<BackupRun> {
  const db = getDb();
  await releaseStuck(db, now);
  if (backupsPausedOn((await readSettings(db))['storage.backups_paused_until'], businessDate(now))) return skip(db, now, 'PAUSED');
  let started: typeof backupRuns.$inferSelect | undefined;
  try {
    [started] = await db.insert(backupRuns).values({ id: newId(), trigger: 'NIGHTLY', status: 'RUNNING', requestedAt: now, startedAt: now }).returning();
  } catch (error) {
    if (violatedConstraint(error) === 'backup_runs_one_active') return skip(db, now, 'BUSY');
    throw error;
  }
  if (!started) throw new Error('the nightly backup was not recorded');
  return finish(db, started.id, runner);
}

/** ADR-0050: pause the nightly backup through a day — at most 30 days on — or lift the pause with null. Audited as a settings change. */
export async function pauseBackups(ctx: Ctx, until: string | null): Promise<void> {
  authorize(ctx, 'system.manage_storage');
  if (until !== null) assertPauseUntil(until, businessDate(ctx.now));
  await inTx(ctx, (tx) => writeSettings(tx, ctx, [{ key: 'storage.backups_paused_until', value: until }]));
}

/** The latest runs, newest first, with who asked for each. */
export async function recentBackupRuns(db: Executor = getDb(), limit = 10): Promise<BackupRun[]> {
  const rows = await db.select({ run: backupRuns, by: users.name }).from(backupRuns)
    .leftJoin(users, eq(users.id, backupRuns.requestedBy))
    .orderBy(desc(backupRuns.requestedAt)).limit(limit);
  return rows.map((r) => toRun(r.run, r.by));
}

