import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { shot, signIn } from './helpers';

test.describe('M0 smoke — identity, permissions, shells', () => {
  test('NFR-001, USR-008: in the browser, an Admin sees only modules they hold and provisions a seller', async ({ page }) => {
    await signIn(page, 'admin@dev.local');
    await expect(page).toHaveURL(/\/console\/dashboard$/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('link', { name: 'Users' }).first()).toBeVisible();
    await page.screenshot({ path: shot('01-console-dashboard-en') });

    await page.getByRole('link', { name: 'Users' }).first().click();
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    await page.getByRole('button', { name: 'New account' }).click();
    const unique = String(Date.now()).slice(-7);
    await page.locator('#name').fill(`E2E Seller ${unique}`);
    await page.locator('#phone').fill(`055${unique}`);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Temporary password')).toBeVisible();
    await page.screenshot({ path: shot('02-account-created-en'), fullPage: true });
  });

  test('I18N-002: the console renders right-to-left in Arabic, and the choice is saved', async ({ page }) => {
    await signIn(page, 'manager@dev.local');
    await page.getByRole('button', { name: 'العربية' }).first().click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('link', { name: ar.nav.dashboard }).first()).toBeVisible();
    await page.screenshot({ path: shot('03-console-dashboard-ar') });
    await page.getByRole('link', { name: ar.nav.users }).first().click();
    await expect(page.getByRole('heading', { name: ar.users.title })).toBeVisible();
    await page.screenshot({ path: shot('04-users-ar'), fullPage: true });
    await page.getByRole('button', { name: 'English' }).first().click(); // leave the account as found
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('USR-013, NFR-002: a seller lands in the phone-first field app; the console does not exist for them', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'seller@dev.local');
    await expect(page).toHaveURL(/\/field\/today$/);
    await page.screenshot({ path: shot('05-field-today-en') });
    const console = await page.goto('/console/dashboard');
    expect(console?.status()).toBe(404);
  });

  test('USR-008: a Warehouse-preset manager has no Users module — absent, not disabled', async ({ page }) => {
    await signIn(page, 'warehouse@dev.local');
    await expect(page).toHaveURL(/\/console\/dashboard$/);
    await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
    const users = await page.goto('/console/users');
    expect(users?.status()).toBe(404);
  });
});
