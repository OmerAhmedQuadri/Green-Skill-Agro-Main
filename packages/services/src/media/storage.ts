import { statfs } from 'node:fs/promises';
import { loadConfig } from '@gsa/config';
import {
  backupsRemovedBy, backupsSwitchedOn, businessDate, canReadMedia, DomainError, isStoredKind, nextRetentionRun, parseSetting, RETENTION_SETTING,
  retentionDueOn, retentionOf, STORED_KINDS, type MediaKind, type RetentionPeriod, type SettingKey, type Settings, type StoredKind,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, gte, isNotNull, isNull, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { authorize, type Ctx } from '../context';
import { audit, inTx, type Executor } from '../platform';
import { getDb } from '../runtime';
import { lastBackupReport, readSettings, writeSettings, type LastBackupReport } from '../system';
import { dueOn, isFileOpen, type FileCount } from './retention';

const { mediaAssets, deliveryDocuments, users } = schema;

/** One kind of file on the storage page (ADR-0049, SYS-013). Sizes are in bytes. */
export type KindUsage = {
  readonly kind: StoredKind;
  readonly period: RetentionPeriod;
  readonly files: number;
  readonly bytes: number;
  /** Stored in the last 30 days — the rate the kind grows at. */
  readonly added: FileCount;
  readonly oldest: Date | null;
  /** Kept forever, one by one. */
  readonly kept: number;
  /** Deleted under the policy so far. */
  readonly deleted: FileCount;
  /** Due at the next run. */
  readonly due: FileCount;
};

export type StorageOverview = {
  readonly kinds: readonly KindUsage[];
  /** The media bucket: photos, slips, vouchers and delivery documents. */
  readonly media: { readonly bucket: string } & FileCount;
  /** The backups bucket as the last backup run reported it (`backup.completed`); null until one has. */
  readonly backups: {
    readonly bucket: string | null; readonly count: number; readonly bytes: number;
    readonly newestAt: Date | null; readonly oldestAt: Date | null; readonly reportedAt: Date;
    /** What the next backup removes under the current period — by the rule it deletes by. */
    readonly due: FileCount;
  } | null;
  readonly backupRetentionDays: number;
  /** Whether this server takes backups at all: all three backup settings are in its `.env`. */
  readonly backupsOn: boolean;
  /** Both buckets together: what Cloudflare bills, and what the budget measures (ADR-0049, amended). */
  readonly r2Bytes: number;
  readonly budgetGb: number;
  readonly budgetBytes: number;
  readonly nextRunAt: Date;
  readonly database: { readonly bytes: number };
  /** The server's own disk; null where it cannot be read. */
  readonly disk: { readonly totalBytes: number; readonly freeBytes: number } | null;
};

/** Gigabytes as storage providers count them. */
export const GB = 1_000_000_000;
const ADDED_WINDOW_MS = 30 * 86_400_000;

const count = (where: SQL | undefined) => sql<number>`count(*) filter (where ${where})`.mapWith(Number);
const total = (column: AnyColumn, where: SQL | undefined) => sql<number>`coalesce(sum(${column}) filter (where ${where}), 0)`.mapWith(Number);

async function mediaUsage(db: Executor, since: Date) {
  const live = eq(mediaAssets.status, 'READY');
  // Confirmed once, deleted since — an upload abandoned before it was confirmed was never stored.
  const gone = and(eq(mediaAssets.status, 'PURGED'), isNotNull(mediaAssets.confirmedAt));
  return db.select({
    kind: mediaAssets.kind,
    files: count(live), bytes: total(mediaAssets.byteSize, live),
    addedFiles: count(and(live, gte(mediaAssets.createdAt, since))), addedBytes: total(mediaAssets.byteSize, and(live, gte(mediaAssets.createdAt, since))),
    oldest: sql<Date | null>`min(${mediaAssets.createdAt}) filter (where ${live})`.mapWith(mediaAssets.createdAt),
    kept: count(and(live, isNotNull(mediaAssets.keptAt))),
    deletedFiles: count(gone), deletedBytes: total(mediaAssets.byteSize, gone),
  }).from(mediaAssets).groupBy(mediaAssets.kind);
}

async function documentUsage(db: Executor, since: Date) {
  const live = and(eq(deliveryDocuments.status, 'READY'), isNull(deliveryDocuments.purgedAt));
  const gone = isNotNull(deliveryDocuments.purgedAt);
  const [row] = await db.select({
    files: count(live), bytes: total(deliveryDocuments.byteSize, live),
    addedFiles: count(and(live, gte(deliveryDocuments.renderedAt, since))),
    addedBytes: total(deliveryDocuments.byteSize, and(live, gte(deliveryDocuments.renderedAt, since))),
    oldest: sql<Date | null>`min(${deliveryDocuments.renderedAt}) filter (where ${live})`.mapWith(deliveryDocuments.renderedAt),
    kept: count(and(live, isNotNull(deliveryDocuments.keptAt))),
    deletedFiles: count(gone), deletedBytes: total(deliveryDocuments.byteSize, gone),
  }).from(deliveryDocuments);
  return row;
}

async function diskSpace(): Promise<StorageOverview['disk']> {
  try {
    const fs = await statfs(process.cwd());
    return { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize };
  } catch {
    return null;
  }
}

/** SYS-013: what is stored, kind by kind, against the budget — with the database, the backups and the server disk. */
export async function storageOverview(ctx: Ctx): Promise<StorageOverview> {
  authorize(ctx, 'system.manage_storage');
  const db = ctx.tx ?? getDb();
  const settings = await readSettings(db);
  const since = new Date(ctx.now.getTime() - ADDED_WINDOW_MS);
  const nextRunAt = nextRetentionRun(ctx.now);
  const [mediaRows, documents, due, [size], disk, report] = await Promise.all([
    mediaUsage(db, since), documentUsage(db, since), dueOn(db, settings, businessDate(nextRunAt)),
    db.select({ bytes: sql<number>`pg_database_size(current_database())`.mapWith(Number) }).from(sql`(select 1) as one`),
    diskSpace(), lastBackupReport(db),
  ]);
  const byKind = new Map<StoredKind, NonNullable<typeof documents>>(mediaRows.map((r) => [r.kind, r]));
  if (documents) byKind.set('DELIVERY_DOCUMENT', documents);

  const kinds = STORED_KINDS.map((kind): KindUsage => {
    const r = byKind.get(kind);
    return {
      kind, period: retentionOf(settings, kind),
      files: r?.files ?? 0, bytes: r?.bytes ?? 0,
      added: { files: r?.addedFiles ?? 0, bytes: r?.addedBytes ?? 0 },
      oldest: r?.oldest ?? null, kept: r?.kept ?? 0,
      deleted: { files: r?.deletedFiles ?? 0, bytes: r?.deletedBytes ?? 0 },
      due: due[kind],
    };
  });
  const budgetGb = settings['storage.budget_gb'];
  const days = settings['storage.backup_retention_days'];
  const config = loadConfig();
  const media = { bucket: config.S3_BUCKET, files: kinds.reduce((n, k) => n + k.files, 0), bytes: kinds.reduce((n, k) => n + k.bytes, 0) };
  return {
    kinds, media,
    backups: report ? {
      bucket: report.bucket, count: report.count, bytes: report.bytes, newestAt: report.newestAt, oldestAt: report.oldestAt,
      reportedAt: report.reportedAt, due: backupsRemovedBy(report.copies, { now: ctx.now, days }),
    } : null,
    backupRetentionDays: days,
    backupsOn: backupsSwitchedOn({ bucket: config.BACKUP_S3_BUCKET, accessKey: config.BACKUP_S3_ACCESS_KEY, secretKey: config.BACKUP_S3_SECRET_KEY }),
    r2Bytes: media.bytes + (report?.bytes ?? 0),
    budgetGb, budgetBytes: budgetGb * GB, nextRunAt,
    database: { bytes: size?.bytes ?? 0 }, disk,
  };
}

export type StoragePolicyChange = {
  readonly periods?: Partial<Record<string, unknown>> | undefined;
  readonly budgetGb?: unknown;
  /** ADR-0049 (amended): how long the nightly backup keeps backups. */
  readonly backupRetentionDays?: unknown;
  /** The Super Admin has seen what the change deletes at the next run, and goes ahead (SYS-012). */
  readonly confirm?: boolean | undefined;
};

function parseChange(change: StoragePolicyChange): { key: SettingKey; value: unknown }[] {
  const parsed: { key: SettingKey; value: unknown }[] = [];
  for (const [kind, value] of Object.entries(change.periods ?? {})) {
    if (!isStoredKind(kind)) throw new DomainError('INVALID_SETTING', { key: kind });
    parsed.push({ key: RETENTION_SETTING[kind], value: parseSetting(RETENTION_SETTING[kind], value) });
  }
  if (change.budgetGb !== undefined) parsed.push({ key: 'storage.budget_gb', value: parseSetting('storage.budget_gb', change.budgetGb) });
  if (change.backupRetentionDays !== undefined) {
    parsed.push({ key: 'storage.backup_retention_days', value: parseSetting('storage.backup_retention_days', change.backupRetentionDays) });
  }
  return parsed;
}

const withChanges = (settings: Settings, parsed: readonly { key: SettingKey; value: unknown }[]): Settings =>
  ({ ...settings, ...Object.fromEntries(parsed.map((p) => [p.key, p.value])) });

/** What the next backup removes under a period, from the copies the last backup reported; null when none has. */
const backupsDue = (report: LastBackupReport | null, days: number, now: Date): FileCount | null =>
  (report ? backupsRemovedBy(report.copies, { now, days }) : null);

/**
 * What the next run would delete if these periods were saved, and what the
 * next backup would remove — the figures the page asks the Super Admin to confirm.
 */
export async function previewStoragePolicy(
  ctx: Ctx, change: StoragePolicyChange,
): Promise<{ runAt: Date; due: Record<StoredKind, FileCount>; backups: FileCount | null }> {
  authorize(ctx, 'system.manage_storage');
  const db = ctx.tx ?? getDb();
  const runAt = nextRetentionRun(ctx.now);
  const proposed = withChanges(await readSettings(db), parseChange(change));
  return {
    runAt, due: await dueOn(db, proposed, businessDate(runAt)),
    backups: backupsDue(await lastBackupReport(db), proposed['storage.backup_retention_days'], ctx.now),
  };
}

/**
 * SYS-010, SYS-012: new periods or a new budget. A change that would delete
 * more at the next run than the current periods do is refused unless the
 * Super Admin confirms it, and so is any shorter period for backups, whatever
 * the last report says; the refusal says how much. Audited as a settings change.
 */
export async function setStoragePolicy(ctx: Ctx, change: StoragePolicyChange): Promise<StorageOverview> {
  authorize(ctx, 'system.manage_storage');
  const parsed = parseChange(change);
  if (parsed.length === 0) throw new DomainError('INVALID_SETTING', { key: null });
  await inTx(ctx, async (tx) => {
    const current = await readSettings(tx);
    const runDay = businessDate(nextRetentionRun(ctx.now));
    const proposed = withChanges(current, parsed);
    const [before, after] = [await dueOn(tx, current, runDay), await dueOn(tx, proposed, runDay)];
    const more = STORED_KINDS.filter((k) => after[k].files > before[k].files);
    const [daysNow, daysThen] = [current['storage.backup_retention_days'], proposed['storage.backup_retention_days']];
    if ((more.length > 0 || daysThen < daysNow) && change.confirm !== true) {
      const report = daysThen < daysNow ? await lastBackupReport(tx) : null;
      const [backupsNow, backupsThen] = [backupsDue(report, daysNow, ctx.now), backupsDue(report, daysThen, ctx.now)];
      throw new DomainError('STORAGE_CONFIRM_DELETES', {
        files: more.reduce((n, k) => n + after[k].files - before[k].files, 0),
        bytes: more.reduce((n, k) => n + after[k].bytes - before[k].bytes, 0),
        backups: backupsNow && backupsThen
          ? { files: backupsThen.files - backupsNow.files, bytes: backupsThen.bytes - backupsNow.bytes }
          : null,
      });
    }
    await writeSettings(tx, ctx, parsed);
  });
  return storageOverview(ctx);
}

/** A file's own page (ADR-0049): what it is, how long it is kept, and — once deleted — when. */
export type FileDetails = {
  readonly id: string;
  readonly kind: MediaKind;
  readonly status: 'READY' | 'PURGED';
  readonly contentType: string;
  readonly byteSize: number | null;
  readonly storedAt: Date;
  readonly capturedAt: Date | null;
  readonly uploadedBy: string;
  readonly purgedAt: Date | null;
  readonly kept: { readonly at: Date; readonly by: string } | null;
  readonly period: RetentionPeriod;
  /** The business day of the run that deletes it; null when it is kept, kept forever by its kind, or already gone. */
  readonly deletesOn: string | null;
  /** Its record is still open, so it stays past that day until the record closes. */
  readonly open: boolean;
  readonly canKeep: boolean;
};

const keeper = alias(users, 'keeper');

/** For whoever may read the file — and still for them once it has been deleted, so a link explains itself. */
export async function fileDetails(ctx: Ctx, mediaId: string): Promise<FileDetails> {
  const db = ctx.tx ?? getDb();
  const [row] = await db.select({ asset: mediaAssets, uploader: users.name, keeper: keeper.name }).from(mediaAssets)
    .innerJoin(users, eq(users.id, mediaAssets.uploadedBy))
    .leftJoin(keeper, eq(keeper.id, mediaAssets.keptBy))
    .where(eq(mediaAssets.id, mediaId));
  const asset = row?.asset;
  if (!row || !asset || (asset.status !== 'READY' && !(asset.status === 'PURGED' && asset.confirmedAt))
    || !canReadMedia(asset.kind, ctx.permissions, asset.uploadedBy === ctx.user.id)) {
    throw new DomainError('NOT_FOUND', { entity: 'media', id: mediaId });
  }
  const period = retentionOf(await readSettings(db), asset.kind);
  const live = asset.status === 'READY';
  return {
    id: asset.id, kind: asset.kind, status: live ? 'READY' : 'PURGED', contentType: asset.contentType, byteSize: asset.byteSize,
    storedAt: asset.createdAt, capturedAt: asset.capturedAt, uploadedBy: row.uploader, purgedAt: asset.purgedAt,
    kept: asset.keptAt ? { at: asset.keptAt, by: row.keeper ?? '' } : null,
    period,
    deletesOn: live && !asset.keptAt ? retentionDueOn(asset.createdAt, period) : null,
    open: live && await isFileOpen(db, asset.id),
    canKeep: live && ctx.permissions.has('system.keep_files'),
  };
}

/** SYS-011: keep one file forever, whatever its kind's period — or hand it back to the policy. Audited. */
export async function keepFile(ctx: Ctx, mediaId: string, keep: boolean): Promise<FileDetails> {
  authorize(ctx, 'system.keep_files');
  await inTx(ctx, async (tx) => {
    // Locked: the nightly run marks and deletes under the same lock, so either the keeping or the deletion comes first, whole.
    const [asset] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId)).for('update');
    if (!asset || (asset.status !== 'READY' && asset.status !== 'PURGED') || !canReadMedia(asset.kind, ctx.permissions, asset.uploadedBy === ctx.user.id)) {
      throw new DomainError('NOT_FOUND', { entity: 'media', id: mediaId });
    }
    if (asset.status === 'PURGED') throw new DomainError('FILE_DELETED', { deletedOn: asset.purgedAt ? businessDate(asset.purgedAt) : null });
    if ((asset.keptAt !== null) === keep) return;
    await tx.update(mediaAssets).set(keep ? { keptAt: ctx.now, keptBy: ctx.user.id } : { keptAt: null, keptBy: null })
      .where(eq(mediaAssets.id, mediaId));
    await audit(tx, ctx, { action: keep ? 'media.kept' : 'media.released', entityType: 'media', entityId: mediaId, after: { kind: asset.kind } });
  });
  return fileDetails(ctx, mediaId);
}
