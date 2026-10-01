import { expect, test, type Page } from '@playwright/test';
import { sessionPage, signIn } from './helpers';

/**
 * The notification panel closed only from the bell or by choosing a
 * notification, so it stayed open over whatever the person turned to next. It
 * is dismissed now the way a popover is expected to be: a press anywhere else,
 * Escape, focus moving away, or leaving the page.
 *
 * By test id, not by name: the labels are translated. The console renders a
 * bell in the sidebar and another in the mobile header, so take whichever the
 * width actually shows.
 */
const bellOf = (page: Page) => page.locator('[data-testid="notification-bell"]:visible').first();
const panelOf = (page: Page) => page.getByTestId('notification-panel');

async function openPanel(page: Page) {
  await bellOf(page).click();
  await expect(panelOf(page)).toBeVisible();
}

test.describe('notification panel', () => {
  test('closes when you press anywhere else on the page', async ({ browser, baseURL }) => {
    const page = await sessionPage(browser, 'admin@dev.local', 'en', baseURL ?? '');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/console/dashboard');
    await openPanel(page);

    await page.locator('main').click({ position: { x: 600, y: 400 } });
    await expect(panelOf(page)).toBeHidden();

    // And the bell still works afterwards: pressing it is not "outside".
    await openPanel(page);
    await bellOf(page).click();
    await expect(panelOf(page)).toBeHidden();
  });

  test('closes on Escape, and gives the keyboard back to the bell', async ({ browser, baseURL }) => {
    const page = await sessionPage(browser, 'admin@dev.local', 'en', baseURL ?? '');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/console/dashboard');
    await openPanel(page);

    await page.keyboard.press('Escape');
    await expect(panelOf(page)).toBeHidden();
    await expect(bellOf(page)).toBeFocused();
    await expect(bellOf(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('closes when the page changes, the back button included', async ({ browser, baseURL }) => {
    const page = await sessionPage(browser, 'admin@dev.local', 'en', baseURL ?? '');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/console/dashboard');
    await page.locator('a[href="/console/users"]:visible').first().click();
    await expect(page).toHaveURL(/\/console\/users$/);

    // The shell survives a client-side navigation, so the panel's state does
    // too — nothing on the page is pressed, and only the address changes.
    await openPanel(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/console\/dashboard$/);
    await expect(panelOf(page)).toBeHidden();
  });

  test('NFR-002: closes when you tap elsewhere on a phone', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL: baseURL ?? '', hasTouch: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await signIn(page, 'seller@dev.local');
    await expect(page).toHaveURL(/\/field\/today$/);
    await bellOf(page).tap();
    await expect(panelOf(page)).toBeVisible();

    // Well below the panel, which is at most 24rem tall under the header.
    await page.touchscreen.tap(195, 800);
    await expect(panelOf(page)).toBeHidden();
    await context.close();
  });
});
