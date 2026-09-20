import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from './migrate-runner';

/**
 * Drops everything this project owns and builds it again from the migrations
 * (DEVELOPMENT §6). For local development only — it destroys data.
 *
 * Runs as the owner role, like migrations do (ADR-0008). The `pgboss` schema is
 * owned by the runtime role, so it is dropped here too and recreated by
 * `bootstrap.sql`; leaving a half-migrated queue behind an otherwise fresh
 * database is worse than starting both together.
 */
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('DATABASE_OWNER_URL is required to reset the database');

// A reset in an environment that holds real work would be unrecoverable.
if (process.env.NODE_ENV === 'production') throw new Error('refusing to reset the database with NODE_ENV=production');
if (!/localhost|127\.0\.0\.1/.test(url)) {
  throw new Error(`refusing to reset a database that is not local: ${url.replace(/:\/\/[^@]*@/, '://***@')}`);
}

const bootstrap = await readFile(fileURLToPath(new URL('../sql/bootstrap.sql', import.meta.url)), 'utf8');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('drop schema if exists public cascade');
  await client.query('drop schema if exists pgboss cascade');
  await client.query('drop schema if exists drizzle cascade');
  await client.query('create schema public');
  // The owner must keep its own schema, and bootstrap.sql grants the rest.
  await client.query('grant all on schema public to current_user');
  await client.query(bootstrap);
} finally {
  await client.end();
}

await runMigrations(url);
console.log('database reset: schema dropped, bootstrap applied, migrations run. Seed it with pnpm db:seed');
