import { DomainError } from '../errors';
import { addDays, isCalendarDate } from '../time';

/**
 * Which backups retention removes (ADR-0020, ADR-0049, handover RUNBOOK §5).
 *
 * Kept apart from the backup script and free of I/O so it can be tested — and
 * so the storage page can say what a shorter period would remove by the same
 * rule the script deletes by. This is the code that deletes the only copies of
 * the business, and "it looked right" is not the standard for that.
 */

/** `size` is in bytes, when the listing gave one. */
export type StoredBackup = { readonly key: string; readonly modified: Date; readonly size?: number | undefined };

/**
 * The only name this system gives a backup, and so the only shape retention
 * will ever delete. Anything else in the bucket — a file someone put there by
 * hand, another system sharing it — is left alone.
 */
export const BACKUP_NAME = /^gsa-\d{8}T\d{6}Z\.dump$/;

/** What every backup key starts with, so a listing can ask for ours alone. */
export const BACKUP_PREFIX = 'gsa-';

/** `gsa-20260921T031500Z.dump` — sorts chronologically, and says when at a glance. */
export function backupKey(at: Date): string {
  return `gsa-${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.dump`;
}

export type Retention = {
  /** Safe to delete. */
  readonly remove: readonly StoredBackup[];
  /**
   * What is left afterwards, oldest first — the number an operator reads to
   * check nothing has gone missing, so it is computed here rather than counted
   * again at the call site. The listing is taken *after* the upload, so the
   * backup just written is already one of these and must not be added twice.
   */
  readonly remaining: readonly StoredBackup[];
  /** Set when expired backups were found and deliberately kept; the reason to print. */
  readonly refused: string | null;
};

/**
 * Backups older than `days`, except the one just written.
 *
 * If that would empty the bucket, nothing is removed and the caller is told
 * why. A clock wrong by a year, a retention misread as hours, or an upload
 * that failed while the prune ran would each otherwise end with the last copy
 * of the business being tidied away — which is the one outcome this whole
 * exercise exists to prevent.
 */
export function expiredBackups(
  stored: readonly StoredBackup[],
  { now, days, justWritten }: { now: Date; days: number; justWritten?: string | undefined },
): Retention {
  const ours = stored.filter((b) => BACKUP_NAME.test(b.key));
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const remove = ours.filter((b) => b.modified < cutoff && b.key !== justWritten);
  if (remove.length > 0 && remove.length >= ours.length) {
    return { remove: [], remaining: ours, refused: `all ${ours.length} backup(s) look older than ${days} days — check the backups' period on the Storage page and the server clock` };
  }
  return { remove, remaining: ours.filter((b) => !remove.includes(b)), refused: null };
}

/** What a run would remove under `days` — files and bytes — by exactly the rule above. */
export function backupsRemovedBy(stored: readonly StoredBackup[], { now, days }: { now: Date; days: number }): { files: number; bytes: number } {
  const { remove } = expiredBackups(stored, { now, days });
  return { files: remove.length, bytes: remove.reduce((n, b) => n + (b.size ?? 0), 0) };
}

/**
 * Whether a server takes backups at all: all three backup settings are in its
 * `.env`. One without them — development, CI, a server not yet set up — says
 * so on its storage page rather than promising a backup that will not come.
 */
export function backupsSwitchedOn(env: { readonly bucket?: string | undefined; readonly accessKey?: string | undefined; readonly secretKey?: string | undefined }): boolean {
  return Boolean(env.bucket && env.accessKey && env.secretKey);
}

/**
 * One page of a bucket listing (S3 `ListObjectsV2`): the backups on it, and
 * the token for the next page when there is one. Anything not named like a
 * backup is passed over — nothing here touches what it did not name.
 */
export function parseBackupListing(xml: string): { readonly backups: StoredBackup[]; readonly next: string | null } {
  const backups: StoredBackup[] = [];
  for (const [, entry = ''] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([^<]+)<\/Key>/.exec(entry)?.[1];
    const modified = /<LastModified>([^<]+)<\/LastModified>/.exec(entry)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(entry)?.[1];
    if (key && modified && BACKUP_NAME.test(key)) backups.push({ key, modified: new Date(modified), size: size ? Number(size) : undefined });
  }
  const next = /<IsTruncated>true<\/IsTruncated>/.test(xml)
    ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null)
    : null;
  return { backups, next };
}

/** The backup to restore from (ADR-0050): the one named, or else the newest. */
export function chooseBackup(backups: readonly StoredBackup[], key?: string): StoredBackup | undefined {
  if (key) return backups.find((b) => b.key === key);
  return [...backups].sort((a, b) => b.modified.getTime() - a.modified.getTime())[0];
}

/** A `pg_dump -Fc` archive begins "PGDMP". Anything else is not a backup this system took. */
export function isPgDump(head: Uint8Array): boolean {
  return [0x50, 0x47, 0x44, 0x4d, 0x50].every((byte, i) => head[i] === byte);
}

/** ADR-0050: a pause is at most this many days long — it always ends by itself. */
export const BACKUP_PAUSE_MAX_DAYS = 30;
/** No newer backup than this, while backups are on and not paused: the nightly one has stopped. */
export const BACKUP_STALE_AFTER_MS = 36 * 3_600_000;
/** The shortest gap between one backup and a second asked for by hand. */
export const BACKUP_MANUAL_GAP_MS = 10 * 60_000;

/** Whether the nightly backup on business day `today` is paused: through `until`, inclusive. */
export function backupsPausedOn(until: string | null, today: string): boolean {
  return until !== null && today <= until;
}

/**
 * A pause must end: after today, and no more than 30 days on. A pause that
 * lasts until somebody remembers to lift it is how backups stop for months.
 */
export function assertPauseUntil(until: string, today: string): void {
  if (!isCalendarDate(until) || until <= today || until > addDays(today, BACKUP_PAUSE_MAX_DAYS)) {
    throw new DomainError('INVALID_SETTING', { key: 'storage.backups_paused_until', latest: addDays(today, BACKUP_PAUSE_MAX_DAYS) });
  }
}

/** The newest backup is more than a day and a half old. */
export function backupIsStale(newestAt: Date | null, now: Date): boolean {
  return newestAt !== null && now.getTime() - newestAt.getTime() > BACKUP_STALE_AFTER_MS;
}

/** Why a run was skipped or cut short, as a code the page words; any other note is the backup script's own message. */
export const BACKUP_NOTES = ['PAUSED', 'BUSY', 'STOPPED'] as const;
export type BackupNote = (typeof BACKUP_NOTES)[number];
export const isBackupNote = (note: string): note is BackupNote => (BACKUP_NOTES as readonly string[]).includes(note);

