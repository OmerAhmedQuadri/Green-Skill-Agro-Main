import { defineConfig } from 'vitest/config';

// Integration tests run against a dedicated gsa_test database (TESTING §3).
// Local runs read .env; CI provides the same variables directly.
try { process.loadEnvFile(new URL('../../.env', import.meta.url)); } catch { /* no .env in CI */ }

const onTestDatabase = (url: string | undefined): string => {
  if (!url) throw new Error('DATABASE_URL and DATABASE_OWNER_URL must be set in .env');
  const parsed = new URL(url);
  parsed.pathname = '/gsa_test';
  return parsed.href;
};

const env = {
  NODE_ENV: 'test',
  DATABASE_URL: onTestDatabase(process.env.DATABASE_URL),
  DATABASE_OWNER_URL: onTestDatabase(process.env.DATABASE_OWNER_URL),
  // TESTING §3: automated tests use the in-memory blob store and never touch R2,
  // whatever .env says. These values only satisfy config validation; the
  // `.invalid` domain can never resolve.
  S3_ENDPOINT: 'https://blob-store.invalid',
  S3_REGION: 'auto',
  S3_BUCKET: 'unused-in-tests',
  S3_ACCESS_KEY: 'unused-in-tests',
  S3_SECRET_KEY: 'unused-in-tests',
};
Object.assign(process.env, env); // global setup runs in this process

export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    env,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
