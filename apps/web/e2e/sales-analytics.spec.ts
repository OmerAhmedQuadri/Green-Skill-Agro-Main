import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aStoreByApi, aVehicle, batchOf, checkIn, freshSeller, post, receiveStock, sessionPage, shot } from './helpers';

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });
// Riyadh's date, not UTC's — as in targets.spec.ts. Saudi Arabia keeps UTC+3 all year.
const riyadhToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const daysBefore = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
/** A money figure as a whole number: "0.00" must not pass on "450.00". */
const amount = (value: string) => new RegExp(`(^|[^\\d.,])${value.replace('.', '\\.')}(?!\\d)`);

/**
 * Sales analytics (ADR-0048), in English and Arabic: a manager narrows the
 * view to one seller from the address, reads the day's net sales in the
 * tiles, the chart, the breakdowns and the list, and narrows it further with
 * the filters and the presets.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Sales analytics (${locale}) — ADR-0048, RPT-001: a period's sales, filtered, charted and listed`, async ({ browser, baseURL }) => {
    test.setTimeout(480_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const lot = `SA-${locale}-${stamp}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: false }, { key: 'attendance.restricted_check_in', enabled: false }] } });

    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 10, lot });
    const seller = await freshSeller(browser, admin, origin, locale, `SA Seller ${locale} ${stamp}`);
    const phone = seller.page;
    const vehicle = await aVehicle(admin, origin, 10_000);
    await post(admin, origin, `/vehicles/${vehicle.id}/assign`, { sellerId: seller.id });
    await checkIn(phone, m, { odometer: '10002' });
    const batchId = await batchOf(admin, skuId, lot);
    const load = await post(admin, origin, '/vehicle-loads', { vehicleId: vehicle.id, lines: [{ batchId, packs: 6 }], acknowledgeCeiling: true });
    await post(phone, origin, `/vehicle-loads/${load.id}/confirm`, { version: load.version });

    // Two sales on account today: three bags and two, at 90.00.
    const store = await aStoreByApi(phone, origin, `SA Store ${locale} ${stamp}`, { creditMode: 'WEEKLY', creditLimit: '5000.00' });
    await post(phone, origin, '/sales', { storeId: store.id, lines: [{ skuId, packs: 3 }] });
    await post(phone, origin, '/sales', { storeId: store.id, lines: [{ skuId, packs: 2 }] });

    // Found from Reports.
    await admin.goto('/console/reports');
    await admin.getByTestId('report-sales').click();
    await expect(admin).toHaveURL(/\/console\/reports\/sales$/);
    await expect(admin.getByRole('heading', { name: m.analytics.title })).toBeVisible();

    // Narrowed to this seller and the last week from the address — a view can be bookmarked and sent.
    const today = riyadhToday();
    await admin.goto(`/console/reports/sales?from=${daysBefore(today, 6)}&to=${today}&sellerId=${seller.id}`);
    await expect(admin.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(admin.getByTestId('tile-net')).toHaveText(amount('450.00'));
    await expect(admin.getByTestId('tile-sold')).toHaveText(amount('450.00'));
    await expect(admin.getByTestId('tile-returned')).toHaveText(amount('0.00'));
    // A column a day, today's carrying the sales and the rest nothing; focusing one reads its figure out.
    await expect(admin.locator('[data-testid^="over-time-"]')).toHaveCount(7);
    const column = admin.getByTestId(`over-time-${today}`);
    await expect(column).toHaveAttribute('aria-label', amount('450.00'));
    await column.focus();
    await expect(admin.getByRole('tooltip')).toContainText('450.00');
    await expect(admin.getByTestId(`by-seller-${seller.id}`)).toContainText('450.00');
    await expect(admin.getByTestId(`by-store-${store.id}`)).toContainText('450.00');
    // The sales behind the figures, both of them.
    await expect(admin.locator('[data-testid^="sale-"]')).toHaveCount(2);
    await admin.screenshot({ path: shot(`sales-analytics-${locale}`), fullPage: true });

    // Narrowed further: nothing came from the warehouse.
    await admin.getByLabel(m.analytics.filters.channel).selectOption('DISPATCH');
    await expect(admin).toHaveURL(/channel=DISPATCH/);
    await expect(admin.getByTestId('tile-net')).toHaveText(amount('0.00'));
    await expect(admin.getByTestId('by-seller')).toHaveCount(0);
    await admin.getByRole('button', { name: m.analytics.filters.clear }).click();
    await expect(admin).not.toHaveURL(/sellerId=/);

    // A preset changes the period: last month, before this seller existed.
    await admin.goto(`/console/reports/sales?sellerId=${seller.id}`);
    await expect(admin.getByTestId('tile-net')).toHaveText(amount('450.00'));
    await admin.getByTestId('preset-lastMonth').click();
    await expect(admin.getByTestId('tile-net')).toHaveText(amount('0.00'));
  });
}
