import { loadConfig } from '@gsa/config';
import { type BranchId } from '@gsa/core';
import { createDb, type Db, schema } from '@gsa/db';
import { asc } from 'drizzle-orm';

let db: Db | undefined;

/** One pool per process, connected as the runtime role (ADR-0008). */
export function getDb(): Db {
  db ??= createDb(loadConfig().DATABASE_URL);
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
