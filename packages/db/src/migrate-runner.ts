import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
export const BOOTSTRAP_SQL = fileURLToPath(new URL('../sql/bootstrap.sql', import.meta.url));

/** Apply every pending migration. Must run as the owner role (ADR-0008). */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const db = createDb(ownerUrl);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await db.$client.end();
  }
}
