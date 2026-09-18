import { expect, type Page } from '@playwright/test';

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
