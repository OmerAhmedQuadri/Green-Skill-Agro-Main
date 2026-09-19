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
      command: 'pnpm start',
      url: 'http://localhost:3000/api/v1/health',
      reuseExistingServer: !process.env.CI,
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
