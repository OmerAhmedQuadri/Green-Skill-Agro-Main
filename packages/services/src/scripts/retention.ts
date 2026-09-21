/**
 * Which backups retention removes (ADR-0020, handover RUNBOOK §5).
 *
 * Kept apart from `backup.ts` and free of I/O so it can be tested: this is the
 * code that deletes the only copies of the business, and "it looked right" is
 * not the standard for that.
 */

export type StoredBackup = { readonly key: string; readonly modified: Date };

/**
 * The only name this system gives a backup, and so the only shape retention
 * will ever delete. Anything else in the bucket — a file someone put there by
 * hand, another system sharing it — is left alone.
 */
export const BACKUP_NAME = /^gsa-\d{8}T\d{6}Z\.dump$/;

/** `gsa-20260921T031500Z.dump` — sorts chronologically, and says when at a glance. */
export function backupKey(at: Date): string {
  return `gsa-${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.dump`;
}

export type Retention = {
  /** Safe to delete. */
  readonly remove: readonly StoredBackup[];
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
    return { remove: [], refused: `all ${ours.length} backup(s) look older than ${days} days — check BACKUP_RETENTION_DAYS and the server clock` };
  }
  return { remove, refused: null };
}
