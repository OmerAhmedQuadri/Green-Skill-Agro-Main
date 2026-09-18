import { loadConfig } from '@gsa/config';
import { createDb, type Db } from '@gsa/db';

let db: Db | undefined;

/** One pool per process, connected as the runtime role (ADR-0008). */
export function getDb(): Db {
  db ??= createDb(loadConfig().DATABASE_URL);
  return db;
}
