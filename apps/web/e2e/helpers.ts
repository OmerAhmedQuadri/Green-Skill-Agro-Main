import { expect, type Browser, type Page } from '@playwright/test';

export const PASSWORD = process.env.DEV_SEED_PASSWORD ?? '';
export const shot = (name: string) => `${process.env.SCREENSHOT_DIR ?? 'test-results/screenshots'}/${name}.png`;

/** Seeded development accounts (DEVELOPMENT §7). */
export async function signIn(page: Page, identifier: string): Promise<void> {
  expect(PASSWORD.length, 'DEV_SEED_PASSWORD must be set').toBeGreaterThanOrEqual(10);
  await page.goto('/login');
  await page.locator('#identifier').fill(identifier);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** Accounts signed in once by the global setup and shared by every spec. */
export const SESSIONS = ['admin@dev.local', 'warehouse@dev.local', 'manager@dev.local'] as const;
export type SessionAccount = (typeof SESSIONS)[number];
export const sessionFile = (account: SessionAccount) => `.auth/${account.replace(/[^a-z]/g, '-')}.json`;

/**
 * A page already signed in as a shared account, in the given language. The
 * language is this browser's cookie only, so specs running side by side in
 * different languages never disturb each other.
 */
export async function sessionPage(browser: Browser, account: SessionAccount, locale: 'en' | 'ar', baseURL: string): Promise<Page> {
  const context = await browser.newContext({ baseURL, storageState: sessionFile(account) });
  await context.addCookies([{ name: 'NEXT_LOCALE', value: locale, url: baseURL }]);
  return context.newPage();
}
