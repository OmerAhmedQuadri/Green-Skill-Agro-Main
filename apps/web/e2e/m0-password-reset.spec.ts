import { expect, test, type APIRequestContext } from '@playwright/test';
import { signIn } from './helpers';

const MAILPIT = 'http://localhost:8025/api/v1';
const NEW_PASSWORD = 'a fresh passphrase for e2e';

/** Waits for the worker to deliver the email to Mailpit, then extracts the reset link. */
async function resetLinkFor(request: APIRequestContext, email: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const search = await request.get(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages } = (await search.json()) as { messages?: { ID: string }[] };
    const id = messages?.[0]?.ID;
    if (id) {
      const message = (await (await request.get(`${MAILPIT}/message/${id}`)).json()) as { Text: string };
      const link = /https?:\/\/\S+\/reset-password\?token=[\w-]+/.exec(message.Text)?.[0];
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('reset email never arrived');
}

test('ADR-0018: forgot password → emailed link → new password → sign in', async ({ page, browser, baseURL, request }) => {
  // A fresh account, so the seeded ones keep their passwords.
  await signIn(page, 'admin@dev.local');
  const unique = String(Date.now());
  const email = `reset-${unique}@dev.local`;
  const created = await page.request.post('/api/v1/users', {
    headers: { 'idempotency-key': `e2e-reset-${unique}`, origin: baseURL ?? '' },
    data: { role: 'SELLER', name: `Reset ${unique}`, email },
  });
  expect(created.status()).toBe(201);

  const visitor = await (await browser.newContext({ baseURL: baseURL ?? '' })).newPage();
  await visitor.goto('/login');
  await visitor.getByRole('link', { name: 'Forgot your password?' }).click();
  await visitor.locator('#email').fill(email);
  await visitor.getByRole('button', { name: 'Send reset link' }).click();
  await expect(visitor.getByText('If an account uses that email')).toBeVisible();

  await visitor.goto(await resetLinkFor(request, email));
  await visitor.locator('#newPassword').fill(NEW_PASSWORD);
  await visitor.locator('#confirmPassword').fill(NEW_PASSWORD);
  await visitor.getByRole('button', { name: 'Set new password' }).click();
  await expect(visitor.getByText('Your password has been changed')).toBeVisible();

  await visitor.goto('/login');
  await visitor.locator('#identifier').fill(email);
  await visitor.locator('#password').fill(NEW_PASSWORD);
  await visitor.locator('form button[type="submit"]').click();
  await expect(visitor).toHaveURL(/\/field\/today$/); // no forced change: they chose this password
});
