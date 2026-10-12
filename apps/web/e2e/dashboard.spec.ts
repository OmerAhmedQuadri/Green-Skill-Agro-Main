import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { post, sessionPage, shot } from './helpers';

/**
 * RPT-012..015 (ADR-0054), in English and Arabic: the dashboard an Admin
 * opens — sales at a glance, the team today, money owed and stock alerts —
 * and the narrower one a warehouse manager's permissions allow.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Dashboard (${locale}) — RPT-012..015: sales, the team, money owed and stock at a glance, each for those allowed it`, async ({ browser, baseURL }) => {
    const origin = baseURL ?? '';
    const blocks = [m.dashboard.sales.title, m.dashboard.team.title, m.dashboard.owed.title, m.dashboard.stock.title];

    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    // A seller who has not come in today.
    const stamp = Date.now();
    const absent = (await post(admin, origin, '/users', {
      role: 'SELLER', name: `D Seller ${locale} ${stamp % 1_000_000}`, email: `d-seller-${locale}-${stamp}@e2e.local`, locale,
    })) as unknown as { account: { id: string } };
    await admin.goto('/console/dashboard');
    for (const title of blocks) await expect(admin.getByRole('heading', { name: title, level: 2 })).toBeVisible();
    await expect(admin.getByTestId('glance-today')).toBeVisible();
    // Thirty days of columns, today the last.
    await expect(admin.locator('[data-testid^="glance-chart-"]')).toHaveCount(30);
    await expect(admin.getByTestId('team-counts')).toBeVisible();
    await expect(admin.getByTestId('owed-ageing')).toBeVisible();
    for (const panel of ['stock-expiring', 'stock-reorder', 'stock-incoming']) await expect(admin.getByTestId(panel)).toBeVisible();
    await expect(admin.getByTestId('signed-in-as')).toHaveCount(0);
    await admin.screenshot({ path: shot(`dashboard-admin-${locale}`), fullPage: true });
    // Whoever is not in is a tap away, so a team of any size stays a glance.
    await expect(admin.getByTestId(`team-${absent.account.id}`)).toHaveCount(0);
    await admin.getByTestId('team-more').click();
    await expect(admin.getByTestId(`team-${absent.account.id}`)).toContainText(m.dashboard.team.statuses.NOT_IN);
    await expect(admin.getByTestId('team-more')).toHaveText(m.dashboard.team.showFewer);

    // The blocked stores open the store list, filtered to them.
    await admin.getByTestId('owed-blocked-link').click();
    await expect(admin).toHaveURL(/\/console\/stores\?blocked=true$/);
    await expect(admin.getByLabel(m.stores.blockedOnly)).toBeChecked();

    // The warehouse sees stock, and none of the money or the team.
    const warehouse = await sessionPage(browser, 'warehouse@dev.local', locale, origin);
    await warehouse.goto('/console/dashboard');
    await expect(warehouse.getByRole('heading', { name: m.dashboard.stock.title, level: 2 })).toBeVisible();
    await expect(warehouse.getByTestId('stock-incoming')).toBeVisible();
    for (const title of blocks.slice(0, 3)) await expect(warehouse.getByRole('heading', { name: title, level: 2 })).toHaveCount(0);
    await warehouse.screenshot({ path: shot(`dashboard-warehouse-${locale}`), fullPage: true });
  });
}
