import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against a production build (TESTING §2.3).
try { process.loadEnvFile(new URL('../../.env', import.meta.url)); } catch { /* CI provides env */ }

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  // One database and shared accounts (a manager whose permissions workflow P
  // changes, photo uploads to one bucket): specs run one at a time (TESTING §3).
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  // A full run on a laptop, with the worker printing documents alongside: a server round trip can pass five seconds.
  expect: { timeout: 10_000 },
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 },
      // NFR-003: a fake camera stands in for the phone's; permission is granted per context.
      launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
    },
  }],
  webServer: [
    {
      // `pnpm start` runs the standalone server the VPS runs (DEVELOPMENT §9),
      // so the suite exercises what ships rather than `next start`.
      command: 'pnpm start',
      url: 'http://localhost:3000/api/v1/health',
      /**
       * Reuse is opt-in, not the default. Anything already on port 3000 — a
       * forgotten `pnpm dev`, a server left by a crashed run — would otherwise
       * be reused silently, and the suite would pass or fail against a build
       * that is not the one under test. Set E2E_REUSE_SERVER=1 for the fast
       * loop when you know what is running; the few seconds a fresh start
       * costs are cheaper than one afternoon spent trusting a stale result.
       */
      reuseExistingServer: !process.env.CI && process.env.E2E_REUSE_SERVER === '1',
      timeout: 120_000,
    },
    {
      // The worker delivers email (ADR-0023); flows like password reset need it running.
      command: 'pnpm --dir ../worker start',
      wait: { stdout: /\[worker\] started/ },
      stdout: 'pipe',
      timeout: 60_000,
    },
  ],
});
