import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client';

// Runs as the owner role; the runtime role cannot alter the schema (ADR-0008).
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('DATABASE_OWNER_URL is required to run migrations');

const db = createDb(url);
await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
await db.$client.end();
console.log('migrations applied');
