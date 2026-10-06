import { expect, test, type Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aStoreByApi, freshSeller, post, sessionPage } from './helpers';

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });
/**
 * One branch of a `{who, select, …}` message, its name filled in — the words
 * the bell shows, the name isolated in its own direction as the bell sets it.
 */
const branch = (message: string, who: 'me' | 'nobody' | 'other', name = '') =>
  (new RegExp(`\\b${who} \\{((?:[^{}]|\\{name\\})*)\\}`).exec(message)?.[1] ?? '').replace('{name}', `\u2068${name}\u2069`);
/** The dashboard's count for a queue; a queue with nothing waiting is left out. */
const waitingCount = async (page: Page, queue: string) => {
  const badge = page.getByTestId(`waiting-count-${queue}`);
  return (await badge.count()) === 0 ? 0 : Number(await badge.textContent());
};
const openBell = async (page: Page) => {
  await page.locator('[data-testid="notification-bell"]:visible').first().click();
  await expect(page.getByTestId('notification-panel')).toBeVisible();
};

/**
 * ADR-0051: a request goes to everyone who can decide it. When one of them
 * does, every copy says who, and stops counting; the dashboard lists what is
 * still waiting, and opens the list filtered to it. In English and Arabic.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`SYS-014, SYS-016 (${locale}): one approver decides a store; every approver's bell says who, and the dashboard stops counting it`, async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    const manager = await sessionPage(browser, 'manager@dev.local', locale, origin);
    await admin.setViewportSize({ width: 1440, height: 900 });
    await manager.setViewportSize({ width: 1440, height: 900 });
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: true }] } });
    const seller = await freshSeller(browser, admin, origin, locale, `N Seller ${locale} ${stamp}`);
    const storeName = `N Store ${locale} ${stamp}`;
    const store = await aStoreByApi(seller.page, origin, storeName, { creditMode: 'WEEKLY', creditLimit: '1000.00' });

    // SYS-016: counted on the dashboard, which opens the stores waiting.
    await admin.goto('/console/dashboard');
    await expect(admin.getByTestId('waiting-STORES')).toContainText(m.dashboard.waiting.queues.STORES);
    const before = await waitingCount(admin, 'STORES');
    expect(before).toBeGreaterThanOrEqual(1);
    await admin.getByTestId('waiting-STORES').click();
    await expect(admin).toHaveURL(/\/console\/stores\?status=PENDING_APPROVAL$/);
    await expect(admin.getByLabel(m.common.status, { exact: true })).toHaveValue('PENDING_APPROVAL');
    await expect(admin.getByText(storeName, { exact: true })).toBeVisible();

    // Before anyone decides, it waits on the admin's bell.
    await openBell(admin);
    const theirs = admin.getByTestId('notification-item').filter({ hasText: storeName });
    await expect(theirs).toBeVisible();
    await expect(theirs.getByTestId('notification-resolution')).toHaveCount(0);

    // SYS-014: the manager approves it. The admin's copy says who did, and the dashboard stops counting it.
    const { name } = (await (await manager.request.get('/api/v1/me')).json()) as { name: string };
    await post(manager, origin, `/stores/${store.id}/approve`, { version: store.version });
    await admin.goto('/console/dashboard');
    expect(await waitingCount(admin, 'STORES')).toBe(before - 1);
    await openBell(admin);
    await expect(theirs.getByTestId('notification-resolution')).toContainText(branch(m.notifications.resolved.APPROVED, 'other', name));

    // And the manager's own copy says they did it.
    await manager.goto('/console/dashboard');
    await openBell(manager);
    const mine = manager.getByTestId('notification-item').filter({ hasText: storeName });
    await expect(mine.getByTestId('notification-resolution')).toContainText(branch(m.notifications.resolved.APPROVED, 'me'));
  });
}
