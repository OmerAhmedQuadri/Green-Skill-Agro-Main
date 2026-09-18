import { readFileSync } from 'node:fs';
import { BOOTSTRAP_SQL, runMigrations } from '@gsa/db';
import pg from 'pg';
import { syncReferenceData } from '../src/reference-data';
import { closeDb } from '../src/runtime';

/** A fresh gsa_test database: bootstrap grants, migrations, reference data — exactly as production. */
export default async function setup(): Promise<void> {
  const ownerUrl = process.env.DATABASE_OWNER_URL;
  if (!ownerUrl) throw new Error('DATABASE_OWNER_URL missing');
  const maintenance = new URL(ownerUrl);
  maintenance.pathname = '/postgres';

  const admin = new pg.Client({ connectionString: maintenance.href });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS gsa_test WITH (FORCE)');
  await admin.query('CREATE DATABASE gsa_test');
  await admin.end();

  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  await owner.query(readFileSync(BOOTSTRAP_SQL, 'utf8'));
  await owner.end();

  await runMigrations(ownerUrl);
  await syncReferenceData(); // as the runtime role, like production
  await closeDb();
}
