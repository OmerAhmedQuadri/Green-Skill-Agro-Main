import type { StoredBackup } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, desc, eq } from 'drizzle-orm';
import { writeAudit, type Executor } from '../platform';
import { defaultBranchId, getDb } from '../runtime';
import { readSettings } from './settings';

const { auditLog } = schema;

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
