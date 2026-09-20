import { expect, test, type Page } from '@playwright/test';
import { sessionPage, signIn } from './helpers';

/**
 * The notification panel is 320px wide and the console's sidebar is 256px, so
 * a panel opening towards the start of the line from the bell in that sidebar
 * hung off the edge of the screen. Nothing else in the suite would notice: the
 * page renders, the panel is in the DOM, and every assertion about its contents
 * passes while half of it is unreachable.
 */
async function panelWithinViewport(page: Page) {
  // By test id, not by name: the label is translated, and this spec runs in
  // both languages. The console renders a bell in the sidebar and another in
  // the mobile header, so take whichever the width actually shows.
  await page.locator('[data-testid="notification-bell"]:visible').first().click();
  const panel = page.getByTestId('notification-panel');
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(box, 'the panel has no box').not.toBeNull();
  expect(viewport, 'no viewport').not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x, 'the panel starts off the left edge').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'the panel runs past the right edge').toBeLessThanOrEqual(viewport.width);
  expect(box.y, 'the panel starts above the top edge').toBeGreaterThanOrEqual(0);
}

test.describe('shell layout', () => {
  test('the notification panel stays on screen in the console, at both widths', async ({ browser, baseURL }) => {
    const page = await sessionPage(browser, 'admin@dev.local', 'en', baseURL ?? '');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/console/dashboard');
    await panelWithinViewport(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await panelWithinViewport(page);
  });

  test('I18N-002: and in Arabic, where start and end are the other way round', async ({ browser, baseURL }) => {
    const page = await sessionPage(browser, 'manager@dev.local', 'ar', baseURL ?? '');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/console/dashboard');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await panelWithinViewport(page);
  });

  test('NFR-002: and in the seller\'s field app on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'seller@dev.local');
    await expect(page).toHaveURL(/\/field\/today$/);
    await panelWithinViewport(page);
  });
});
