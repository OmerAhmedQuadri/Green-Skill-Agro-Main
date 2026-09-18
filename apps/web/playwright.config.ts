import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against a production build (TESTING §2.3).
try { process.loadEnvFile(new URL('../../.env', import.meta.url)); } catch { /* CI provides env */ }

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
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
