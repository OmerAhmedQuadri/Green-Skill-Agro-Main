import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * SECURITY §2 and §7, held by a test rather than by a document.
 *
 * Every other spec would still pass if these headers quietly stopped being
 * sent — a page renders fine without a policy. This one fails instead.
 */
test.describe('security headers and the CSRF gate (SECURITY §2, §7)', () => {
  test('SECURITY §7: a page is served with a nonce policy and the rest of the headers', async ({ page }) => {
    const response = await page.goto('/login');
    const headers = response?.headers() ?? {};

    const csp = headers['content-security-policy'] ?? '';
    // The nonce is per response, so its value is not asserted — its presence is.
    expect(csp).toMatch(/script-src [^;]*'nonce-[^']+'/);
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    // Production must never evaluate; the allowance exists only in development.
    expect(csp).not.toContain("'unsafe-eval'");

    expect(headers['permissions-policy']).toBe('camera=(self), geolocation=(self), microphone=()');
    expect(headers['referrer-policy']).toBe('same-origin');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  test('SECURITY §1, §7: the policy is applied on a real screen, and signing out ends the session', async ({ page }) => {
    const blocked: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy|Refused to (load|execute|apply)/i.test(message.text())) blocked.push(message.text());
    });
    // One sign-in for both halves: an account's rate limit is shared with the
    // rest of the suite, so this spec spends as few as it can.
    await signIn(page, 'warehouse@dev.local');
    await expect(page).toHaveURL(/\/console\/dashboard$/);
    expect(blocked).toEqual([]);

    // Through the button, not a hand-made request: its call carries no body, and
    // it swallows its own errors — so a sign-out the proxy refused would look
    // exactly like a clean one while the session stayed alive.
    const signOut = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/sign-out'));
    await page.getByRole('button', { name: 'Sign out' }).first().click();
    expect((await signOut).status()).toBeLessThan(300);

    await expect(page).toHaveURL(/\/login/);
    expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  });

  test('SECURITY §2: a state-changing request needs our origin and a JSON body', async ({ page }) => {
    await page.goto('/login'); // so page.url() is ours, not about:blank
    const ours = new URL(page.url()).origin;
    const url = '/api/v1/auth/sign-in';
    // An identifier no account has: the refusal is the same, and no real account's
    // failure count or rate limit is spent on it.
    const body = JSON.stringify({ identifier: 'nobody@dev.local', password: 'wrong-on-purpose' });

    const foreign = await page.request.post(url, {
      headers: { origin: 'https://not-green-agro.example', 'content-type': 'application/json' }, data: body,
    });
    expect(foreign.status()).toBe(403);

    // A cross-origin HTML form's content type, from our own origin: still refused.
    const asForm = await page.request.post(url, {
      headers: { origin: ours, 'content-type': 'text/plain' }, data: body,
    });
    expect(asForm.status()).toBe(415);

    // The same request, properly formed, gets as far as the credentials check.
    const proper = await page.request.post(url, {
      headers: { origin: ours, 'content-type': 'application/json' }, data: body,
    });
    expect(proper.status()).toBe(401);
  });
});
