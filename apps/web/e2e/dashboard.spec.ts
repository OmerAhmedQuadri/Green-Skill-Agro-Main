import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { post, sessionPage, shot } from './helpers';

const TABS = ['sales', 'team', 'stores', 'money', 'stock'] as const;

/**
 * RPT-012..016 (ADR-0054), in English and Arabic: the dashboard's tabs — each
 * with the filters it answers to, kept in the address — for the Admin, and
 * the stock tab alone for a warehouse manager.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Dashboard (${locale}) — RPT-012..016: sales, the team, stores, money and stock in tabs, each filtered, each for those allowed it`, async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const origin = baseURL ?? '';
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    // A seller who has not come in today.
    const stamp = Date.now();
    const absent = (await post(admin, origin, '/users', {
      role: 'SELLER', name: `D Seller ${locale} ${stamp % 1_000_000}`, email: `d-seller-${locale}-${stamp}@e2e.local`, locale,
    })) as unknown as { account: { id: string } };

    await admin.goto('/console/dashboard');
    const tabs = admin.getByRole('tablist', { name: m.dashboard.tabsLabel });
    for (const key of TABS) await expect(tabs.getByRole('tab', { name: m.dashboard.tabs[key], exact: true })).toBeVisible();
    await expect(admin.getByTestId('signed-in-as')).toHaveCount(0);

    // Sales: this month to begin with; a preset narrows it, the address keeps it, and the chart follows.
    await expect(admin.getByTestId('tab-sales')).toBeVisible();
    await expect(admin.getByTestId('sales-net')).toBeVisible();
    await expect(admin.getByTestId('dashboard-freshness')).toBeVisible();
    await admin.getByTestId('dash-preset-last7').click();
    await expect(admin).toHaveURL(/[?&]from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    await expect(admin.locator('[data-testid^="sales-chart-"]')).toHaveCount(7);
    await admin.screenshot({ path: shot(`dashboard-sales-${locale}`), fullPage: true });

    // Team: whoever is not in is a tap away; a status picks who is listed.
    await tabs.getByRole('tab', { name: m.dashboard.tabs.team, exact: true }).click();
    await expect(admin).toHaveURL(/tab=team/);
    await expect(admin.getByTestId('team-counts')).toBeVisible();
    await expect(admin.getByTestId(`team-${absent.account.id}`)).toHaveCount(0);
    await admin.getByTestId('team-more').click();
    await expect(admin.getByTestId(`team-${absent.account.id}`)).toContainText(m.dashboard.team.statuses.NOT_IN);
    await admin.getByTestId('team-count-WORKING').click();
    await expect(admin.getByTestId(`team-${absent.account.id}`)).toHaveCount(0);
    await admin.screenshot({ path: shot(`dashboard-team-${locale}`), fullPage: true });

    // Stores: quiet for the days chosen.
    await tabs.getByRole('tab', { name: m.dashboard.tabs.stores, exact: true }).click();
    await expect(admin.getByTestId('stores-quiet')).toBeVisible();
    await admin.getByLabel(m.dashboard.filters.quiet).selectOption('90');
    await expect(admin).toHaveURL(/quiet=90/);
    await expect(admin.getByRole('heading', { name: m.dashboard.stores.quietTitle.replace('{days}', '90') })).toBeVisible();
    await admin.screenshot({ path: shot(`dashboard-stores-${locale}`), fullPage: true });

    // Money: owed, and the money in motion; the blocked stores open the store list, filtered to them.
    await tabs.getByRole('tab', { name: m.dashboard.tabs.money, exact: true }).click();
    await expect(admin.getByTestId('owed-total')).toBeVisible();
    await expect(admin.getByTestId('money-motion')).toBeVisible();
    await admin.screenshot({ path: shot(`dashboard-money-${locale}`), fullPage: true });
    await admin.getByTestId('owed-blocked-link').click();
    await expect(admin).toHaveURL(/\/console\/stores\?blocked=true$/);
    await expect(admin.getByLabel(m.stores.blockedOnly)).toBeChecked();

    // Stock: every part, opened straight from the address.
    await admin.goto('/console/dashboard?tab=stock');
    for (const panel of ['stock-expiring', 'stock-reorder', 'stock-incoming', 'stock-vehicles', 'stock-dispatch']) await expect(admin.getByTestId(panel)).toBeVisible();
    await admin.screenshot({ path: shot(`dashboard-stock-${locale}`), fullPage: true });

    // The warehouse: the stock tab, and nothing else.
    const warehouse = await sessionPage(browser, 'warehouse@dev.local', locale, origin);
    await warehouse.goto('/console/dashboard');
    const theirs = warehouse.getByRole('tablist', { name: m.dashboard.tabsLabel });
    await expect(theirs.getByRole('tab')).toHaveCount(1);
    await expect(theirs.getByRole('tab', { name: m.dashboard.tabs.stock, exact: true })).toBeVisible();
    await expect(warehouse.getByTestId('tab-stock')).toBeVisible();
    await warehouse.screenshot({ path: shot(`dashboard-warehouse-${locale}`), fullPage: true });
  });
}
