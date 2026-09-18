import { defineConfig } from 'drizzle-kit';

// Migrations are generated and applied as the owner role (ADR-0008).
process.loadEnvFile?.('../../.env');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_OWNER_URL ?? '' },
  strict: true,
  verbose: true,
});
