import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { sessionPage } from './helpers';

/**
 * Workflow P — configuring a manager's access (WORKFLOWS.md), and the M0 exit
 * check: run in English and in Arabic. Labels come from the message files, so
 * the Arabic run clicks the real Arabic text.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Workflow P (${locale}) — USR-005, USR-007, USR-008, USR-010, USR-011, USR-014, AUD-003: an Admin configures a manager; the manager's console follows; the change is audited`, async ({ browser, baseURL }) => {
    const origin = baseURL ?? '';

    // The Admin works in this run's language.
    const page = await sessionPage(browser, 'admin@dev.local', locale, origin);

    // A new manager, created through the API so the temporary password is at hand.
    const unique = String(Date.now());
    const created = await page.request.post('/api/v1/users', {
      headers: { origin, 'idempotency-key': `wp-${locale}-${unique}` },
      data: { role: 'MANAGER', name: `WP ${locale} ${unique}`, email: `wp-${locale}-${unique}@dev.local`, locale },
    });
    expect(created.status()).toBe(201);
    const { account, temporaryPassword } = (await created.json()) as { account: { id: string; email: string }; temporaryPassword: string };

    // USR-014: apply the Warehouse preset, then adjust — grant staff management on top.
    await page.goto(`/console/users/${account.id}`);
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await page.getByLabel(m.users.preset).selectOption({ label: m.presets.WAREHOUSE });
    await page.getByRole('button', { name: m.users.applyPreset, exact: true }).click();
    await expect(page.getByRole('checkbox', { name: m.permissions.inventory.receive_goods })).toBeChecked();
    // USR-005/007: an action inside a module, not the module wholesale.
    await page.getByRole('checkbox', { name: m.permissions.users.manage_staff }).check();
    await page.getByRole('button', { name: m.users.savePermissions }).click();
    await expect(page.getByText(m.users.noChanges)).toBeVisible();

    // The manager signs in with the temporary password and must replace it.
    const manager = await (await browser.newContext({ baseURL: origin })).newPage();
    await manager.goto('/login');
    await manager.locator('#identifier').fill(account.email);
    await manager.locator('#password').fill(temporaryPassword);
    await manager.locator('form button[type="submit"]').click();
    await expect(manager).toHaveURL(/\/change-password$/);
    await manager.locator('#currentPassword').fill(temporaryPassword);
    await manager.locator('#newPassword').fill('workflow p passphrase');
    await manager.locator('#confirmPassword').fill('workflow p passphrase');
    await manager.locator('form button[type="submit"]').click();
    await expect(manager).toHaveURL(/\/console\/dashboard$/);
    await expect(manager.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(manager.getByRole('link', { name: m.nav.users }).first()).toBeVisible();

    // USR-010: the Admin withdraws it; the manager's next request reflects it.
    await page.reload();
    await page.getByRole('checkbox', { name: m.permissions.users.manage_staff }).uncheck();
    await page.getByRole('button', { name: m.users.savePermissions }).click();
    await expect(page.getByText(m.users.noChanges)).toBeVisible();

    await manager.reload();
    // USR-008: absent — not disabled — and the page itself does not exist for them.
    await expect(manager.getByRole('link', { name: m.nav.users })).toHaveCount(0);
    expect((await manager.goto('/console/users'))?.status()).toBe(404);

    // USR-011, AUD-003: each change is in the audit log with the acting Admin and the time — for Admins only.
    await page.goto('/console/audit-log');
    await page.getByLabel(m.audit.entityId).fill(account.id);
    const changes = page.getByTestId('audit-identity.permissions_changed');
    await expect(changes.first()).toBeVisible();
    expect(await changes.count()).toBeGreaterThanOrEqual(2);
    const me = (await (await page.request.get('/api/v1/me')).json()) as { name: string };
    await expect(changes.first()).toContainText(me.name);
    expect((await manager.goto('/console/audit-log'))?.status()).toBe(404);
  });
}
