import { runMigrations } from './migrate-runner';

// Runs as the owner role; the runtime role cannot alter the schema (ADR-0008).
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('DATABASE_OWNER_URL is required to run migrations');

await runMigrations(url);
console.log('migrations applied');
