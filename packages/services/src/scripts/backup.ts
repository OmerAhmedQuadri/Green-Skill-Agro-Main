import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig } from '@gsa/config';
import { AwsClient } from 'aws4fetch';
import { BACKUP_NAME, backupKey, expiredBackups, type StoredBackup } from './retention';

/**
 * Upload one database dump to the backups bucket and delete the ones past
 * retention (ADR-0020, handover RUNBOOK §5).
 *
 *   pnpm db:backup --file <dump> [--dry-run]
 *
 * `deploy/backup.sh` takes the dump and calls this. The two are separate
 * because the dump comes out of the Postgres container, while the upload needs
 * an S3 client — and the one this repository already depends on is in here, so
 * nothing extra is installed on the server.
 *
 * It uses its own client rather than the application's `BlobStore`: the
 * backups live in a different bucket under a different token (the media token
 * is handed to browsers inside signed upload URLs and must never reach the
 * books), and `BlobStore` has no way to list, which retention needs.
 */

const args = new Map<string, string>();
for (const [i, arg] of process.argv.slice(2).entries()) {
  if (!arg.startsWith('--')) continue;
  const next = process.argv.slice(2)[i + 1];
  args.set(arg.slice(2), next && !next.startsWith('--') ? next : 'yes');
}

const file = args.get('file');
const dryRun = args.has('dry-run');
if (!file || file === 'yes') throw new Error('usage: pnpm db:backup --file <dump> [--dry-run]');

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
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

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

/** Everything in the bucket, oldest first. Paged, in case retention has not run for a while. */
const listAll = async (): Promise<StoredBackup[]> => {
  const found: StoredBackup[] = [];
  let token: string | undefined;
  do {
    const url = new URL(`${base}/${bucket}`);
    url.searchParams.set('list-type', '2');
    if (token) url.searchParams.set('continuation-token', token);
    const response = await client.fetch(url.toString());
    if (response.status !== 200) throw new Error(`listing the bucket failed with HTTP ${response.status}`);
    const xml = await response.text();
    for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const name = /<Key>([^<]+)<\/Key>/.exec(entry ?? '')?.[1];
      const modified = /<LastModified>([^<]+)<\/LastModified>/.exec(entry ?? '')?.[1];
      if (name && modified && BACKUP_NAME.test(name)) found.push({ key: name, modified: new Date(modified) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1]
      : undefined;
  } while (token);
  return found.sort((a, b) => a.modified.getTime() - b.modified.getTime());
};

const kept = await listAll();
const { remove, refused } = expiredBackups(kept, {
  now: new Date(), days: config.BACKUP_RETENTION_DAYS, justWritten: dryRun ? undefined : key,
});

if (refused) console.log(`  keeping every backup: ${refused}`);
for (const old of remove) {
  if (!dryRun) {
    const response = await client.fetch(objectUrl(old.key), { method: 'DELETE' });
    if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
      throw new Error(`deleting ${old.key} failed with HTTP ${response.status}`);
    }
  }
  console.log(`  ${dryRun ? 'would remove' : 'removed'} ${old.key} (older than ${config.BACKUP_RETENTION_DAYS} days)`);
}

const remaining = kept.filter((b) => !remove.includes(b));
console.log(dryRun
  ? `  dry run — nothing was uploaded or removed; ${kept.length} backup(s) in ${bucket}`
  : `  ${remaining.length + 1} backup(s) in ${bucket}, oldest ${remaining[0]?.modified.toISOString().slice(0, 10) ?? 'today'}`);
