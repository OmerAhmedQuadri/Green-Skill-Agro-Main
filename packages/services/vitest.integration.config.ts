import { defineConfig } from 'vitest/config';

// Integration tests run against a dedicated gsa_test database (TESTING §3).
process.loadEnvFile(new URL('../../.env', import.meta.url));

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
  // TESTING §3: tests never touch R2, whatever .env says.
  S3_ENDPOINT: 'http://localhost:8333',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'gsa-test',
  S3_ACCESS_KEY: 'gsa_s3',
  S3_SECRET_KEY: 'gsa_s3_dev_secret',
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
