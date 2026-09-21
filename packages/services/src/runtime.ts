import { loadConfig } from '@gsa/config';
import { type BranchId } from '@gsa/core';
import { createDb, type Db, schema } from '@gsa/db';
import { createS3BlobStore, type BlobStore } from './media';
import { createSmtpMailer, type Mailer } from './notifications';
import { asc } from 'drizzle-orm';

let db: Db | undefined;

/** One pool per process, connected as the runtime role (ADR-0008). */
export function getDb(): Db {
  /**
   * Ten seconds to be handed a connection: long enough to ride out a burst,
   * short enough that a caller is told rather than left waiting. Sixty for one
   * statement — pathological for this application's queries, and generous
   * enough not to cancel the worker's nightly rollups.
   */
  db ??= createDb(loadConfig().DATABASE_URL, { connectionTimeoutMillis: 10_000, statementTimeoutMillis: 60_000 });
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) await db.$client.end();
  db = undefined;
}

let branchId: BranchId | undefined;

/** Phase 1 runs a single branch (ADR-0004); used where no user context exists yet. */
export async function defaultBranchId(): Promise<BranchId> {
  if (branchId) return branchId;
  const [branch] = await getDb().select({ id: schema.branches.id }).from(schema.branches).orderBy(asc(schema.branches.createdAt)).limit(1);
  if (!branch) throw new Error('No branch exists — run the reference-data sync (pnpm db:sync)');
  branchId = branch.id as BranchId;
  return branchId;
}

let blobStore: BlobStore | undefined;

/** Cloudflare R2 via the S3 API (ADR-0020). Tests replace it with the in-memory store. */
export function getBlobStore(): BlobStore {
  if (!blobStore) {
    const c = loadConfig();
    blobStore = createS3BlobStore({
      endpoint: c.S3_ENDPOINT, region: c.S3_REGION, bucket: c.S3_BUCKET,
      accessKeyId: c.S3_ACCESS_KEY, secretAccessKey: c.S3_SECRET_KEY, keyPrefix: c.S3_KEY_PREFIX,
    });
  }
  return blobStore;
}

/** Test seam: swap in an in-memory store. */
export function setBlobStore(store: BlobStore): void {
  blobStore = store;
}

let mailer: Mailer | undefined;

/** nodemailer over SMTP_URL — Mailpit in development (ADR-0022). Tests swap in a memory mailer. */
export function getMailer(): Mailer {
  mailer ??= createSmtpMailer(loadConfig().SMTP_URL, loadConfig().MAIL_FROM);
  return mailer;
}

export function setMailer(next: Mailer): void {
  mailer = next;
}
