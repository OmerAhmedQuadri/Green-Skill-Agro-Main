import { expect, test, type Locator } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { freshSeller, sessionPage, shot } from './helpers';

/** Shown, not just present: the file arrived and the browser drew it. */
const drawn = async (image: Locator) => {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
};

/**
 * ADR-0057, in English and Arabic: Green Agro's logo wherever the app shows
 * its mark — in full on the sign-in page, its emblem in the console and on the
 * phone, and as the browser's and the phone's icon, before anyone signs in —
 * and the sprout in its place when the file cannot be shown.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Brand (${locale}) — ADR-0057: the logo on sign-in, the console and the phone, the app icons, and the sprout when the logo cannot load`, async ({ browser, baseURL }) => {
    const origin = baseURL ?? '';
    // Signed out: the sign-in page and its icons.
    const visitor = await browser.newContext({ baseURL: origin });
    await visitor.addCookies([{ name: 'NEXT_LOCALE', value: locale, url: origin }]);
    const signIn = await visitor.newPage();
    await signIn.goto('/login');
    const logo = signIn.getByTestId('brand-logo');
    await drawn(logo);
    await expect(logo).toHaveAttribute('alt', m.app.name);
    await expect(signIn.getByTestId('brand-symbol')).toHaveCount(0);
    for (const rel of ['icon', 'apple-touch-icon']) {
      const href = await signIn.locator(`link[rel="${rel}"]`).first().getAttribute('href');
      const icon = await signIn.request.get(href ?? '/missing', { maxRedirects: 0 });
      expect(icon.status(), rel).toBe(200);
      expect(icon.headers()['content-type'], rel).toBe('image/png');
    }
    await signIn.screenshot({ path: shot(`brand-login-${locale}`), fullPage: true });

    // The logo cannot load: the sprout, the name and the line under it take its place.
    const blocked = await visitor.newPage();
    await blocked.route(/\/_next\/static\/media\/logo\.[^/]*\.webp/, (route) => route.abort());
    await blocked.goto('/login');
    await expect(blocked.getByTestId('brand-symbol')).toBeVisible();
    await expect(blocked.getByText(m.app.tagline)).toBeVisible();
    await visitor.close();

    // The console: the emblem beside the name, in the green bar.
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.goto('/console/dashboard');
    await drawn(admin.locator('[data-testid="brand-emblem"]:visible').first());
    await expect(admin.locator('[data-testid="brand-symbol"]:visible')).toHaveCount(0);
    await admin.screenshot({ path: shot(`brand-console-${locale}`) });

    // The phone: the emblem beside the name in the header.
    const seller = await freshSeller(browser, admin, origin, locale, `B Seller ${locale} ${String(Date.now()).slice(-6)}`);
    await seller.page.goto('/field/today');
    await drawn(seller.page.getByTestId('brand-emblem'));
    await seller.page.screenshot({ path: shot(`brand-phone-${locale}`) });
  });
}
