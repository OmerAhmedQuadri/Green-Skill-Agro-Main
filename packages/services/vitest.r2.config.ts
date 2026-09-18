import { defineConfig } from 'vitest/config';

// Opt-in contract test against the real R2 test bucket (TESTING §3). Run by
// hand with `pnpm test:r2`; never part of `pnpm test` or CI.
process.loadEnvFile(new URL('../../.env', import.meta.url));

export default defineConfig({
  test: { include: ['src/**/*.r2.test.ts'], testTimeout: 30_000, fileParallelism: false },
});
