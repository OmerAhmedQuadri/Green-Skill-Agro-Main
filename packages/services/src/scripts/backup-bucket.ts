import { loadConfig } from '@gsa/config';
import { BACKUP_PREFIX, parseBackupListing, type StoredBackup } from '@gsa/core';
import { AwsClient } from 'aws4fetch';
import { closeDb } from '../runtime';

/**
 * The backups bucket, for the two scripts that run on the server: taking a
 * backup (`backup.ts`) and fetching one back to restore from
 * (`fetch-backup.ts`) — ADR-0020, ADR-0050.
 *
 * Its own client rather than the application's `BlobStore`: the backups live
 * in a different bucket under a different token (the media token is handed to
 * browsers inside signed upload URLs and must never reach the books), and
 * `BlobStore` has no way to list, which both scripts need.
 */
export function backupBucket() {
  const config = loadConfig();
  const bucket = config.BACKUP_S3_BUCKET;
  const accessKeyId = config.BACKUP_S3_ACCESS_KEY;
  const secretAccessKey = config.BACKUP_S3_SECRET_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'backups are not configured: set BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY and BACKUP_S3_SECRET_KEY in .env.\n' +
      'They are a bucket-scoped R2 token of their own (ADR-0020) — not the media keys.',
    );
  }

  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: config.S3_REGION });
  const base = config.S3_ENDPOINT.replace(/\/+$/, '');
  const objectUrl = (key: string) => `${base}/${bucket}/${encodeURIComponent(key)}`;

  /** Every backup in the bucket, oldest first. Paged, in case retention has not run for a while. */
  const listAll = async (): Promise<StoredBackup[]> => {
    const found: StoredBackup[] = [];
    let token: string | null = null;
    do {
      const url = new URL(`${base}/${bucket}`);
      url.searchParams.set('list-type', '2');
      // Only ours. In a bucket of its own this saves a little; in a bucket shared
      // with media it is the difference between reading thirty keys and paging
      // through every photo in the business to find them.
      url.searchParams.set('prefix', BACKUP_PREFIX);
      if (token) url.searchParams.set('continuation-token', token);
      const response = await client.fetch(url.toString());
      if (response.status !== 200) throw new Error(`listing the bucket failed with HTTP ${response.status}`);
      const page = parseBackupListing(await response.text());
      found.push(...page.backups);
      token = page.next;
    } while (token);
    return found.sort((a, b) => a.modified.getTime() - b.modified.getTime());
  };

  return { bucket, client, objectUrl, listAll };
}

export const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** `--name value` and bare `--flag` arguments, as both scripts take them. */
export function scriptArgs(argv: readonly string[] = process.argv.slice(2)): Map<string, string> {
  const args = new Map<string, string>();
  for (const [i, arg] of argv.entries()) {
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    args.set(arg.slice(2), next && !next.startsWith('--') ? next : 'yes');
  }
  return args;
}

/**
 * A script's body: if it stops, say why in one line — no stack trace — and
 * exit non-zero. The worker shows that line on the storage page as the reason
 * a backup failed (ADR-0050).
 */
export async function asScript(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    console.error(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

