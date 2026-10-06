import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { BACKUP_NAME, backupKey, expiredBackups } from '@gsa/core';
import { backupRetentionDays, reportBackups } from '../system';
import { asScript, backupBucket, mib, scriptArgs } from './backup-bucket';

/**
 * Upload one database dump to the backups bucket and delete the ones past
 * retention (ADR-0020, handover RUNBOOK §5).
 *
 *   pnpm db:backup --file <dump> [--dry-run]
 *
 * `deploy/backup.sh` takes the dump and calls this. The two are separate
 * because the dump comes out of the Postgres container, while the upload needs
 * an S3 client — and the one this repository already depends on is in here, so
 * nothing extra is installed on the server. The bucket client is shared with
 * `fetch-backup.ts` (`backup-bucket.ts`).
 */

await asScript(async () => {
  const args = scriptArgs();
  const file = args.get('file');
  const dryRun = args.has('dry-run');
  if (!file || file === 'yes') throw new Error('usage: pnpm db:backup --file <dump> [--dry-run]');

  const { bucket, client, objectUrl, listAll } = backupBucket();

  const size = statSync(file).size;
  if (size === 0) throw new Error(`${file} is empty — the dump failed; nothing was uploaded`);

  const key = backupKey(new Date());
  console.log(`  ${basename(file)} → ${bucket}/${key}  (${mib(size)})`);

  if (!dryRun) {
    /**
     * Read whole, because SigV4 signs a hash of the body. A Phase 1 dump is tens
     * of megabytes; if one ever approaches a gigabyte this needs multipart, and
     * the line below is where it will fail rather than silently truncate.
     */
    const body = readFileSync(file);
    const put = await client.fetch(objectUrl(key), {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: { 'content-type': 'application/octet-stream' },
    });
    if (put.status !== 200) throw new Error(`upload failed with HTTP ${put.status}`);

    // Proof it arrived whole. An upload that reports success and stores nothing
    // is the failure this whole exercise exists to prevent.
    const head = await client.fetch(objectUrl(key), { method: 'HEAD' });
    const stored = Number(head.headers.get('content-length') ?? -1);
    if (head.status !== 200 || stored !== size) {
      throw new Error(`upload could not be verified: HTTP ${head.status}, stored ${stored} bytes of ${size}`);
    }
    console.log(`  uploaded and verified (${mib(stored)})`);
  }

  const kept = await listAll();

  /**
   * ADR-0049: the Super Admin sets the period on the Storage page. If it cannot
   * be read tonight, nothing is removed — the cost of that is a day's extra
   * backup; the cost of guessing could be every backup.
   */
  let days: number | null = null;
  try {
    days = await backupRetentionDays();
  } catch (error) {
    console.warn(`  could not read the backups' period from the database, so nothing is removed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { remove, remaining, refused } = days === null
    ? { remove: [], remaining: kept.filter((b) => BACKUP_NAME.test(b.key)), refused: null }
    : expiredBackups(kept, { now: new Date(), days, justWritten: dryRun ? undefined : key });

  if (refused) console.log(`  keeping every backup: ${refused}`);
  for (const old of remove) {
    if (!dryRun) {
      const response = await client.fetch(objectUrl(old.key), { method: 'DELETE' });
      if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
        throw new Error(`deleting ${old.key} failed with HTTP ${response.status}`);
      }
    }
    console.log(`  ${dryRun ? 'would remove' : 'removed'} ${old.key} (older than ${days ?? '?'} days)`);
  }

  console.log(dryRun
    ? `  dry run — nothing was uploaded or removed; ${remaining.length} backup(s) in ${bucket}`
    : `  ${remaining.length} backup(s) in ${bucket}, oldest ${remaining[0]?.modified.toISOString().slice(0, 10) ?? 'today'}`);

  /**
   * ADR-0049: the storage page shows the backups as this run left them, read
   * from the audit log — so the web app never needs this bucket's token. A
   * failure here is reported, not fatal: the backup itself is safely stored.
   */
  try {
    if (!dryRun) await reportBackups({ bucket, days, copies: remaining });
  } catch (error) {
    console.warn(`  the backup is stored, but could not be recorded for the storage page: ${error instanceof Error ? error.message : String(error)}`);
  }
});
