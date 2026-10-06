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
