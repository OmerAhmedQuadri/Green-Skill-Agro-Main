import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aStoreByApi, aVehicle, batchOf, checkIn, freshSeller, post, receiveStock, sessionPage } from './helpers';

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);

/**
 * Workflow O — planning the next import order (WORKFLOWS.md), in English and
 * Arabic: what sold feeds the demand rate, the projection runs to today plus
 * the import lead time, a thin SKU is flagged with its workings on show, the
 * output says it is a guide while there is under a year of history, and the
 * recommendation converts into a DRAFT purchase order the manager still edits —
 * the system never orders anything itself.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  const n = (v: string) => (locale === 'ar' ? v.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d) : v);
  test(`Workflow O (${locale}) — RPT-001..006, RPT-011, PO-008: demand, a projection at the lead time, and a draft order`, async ({ browser, baseURL }) => {
    test.setTimeout(480_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const lot = `O-${locale}-${stamp}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: false }, { key: 'attendance.restricted_check_in', enabled: false }] } });
    // A 45-day lead time against 90 days of demand is the shape §11 describes.
    const leadTime = await admin.request.patch('/api/v1/settings', { headers: headers(origin), data: { changes: [{ key: 'imports.lead_time_days', value: 45 }] } });
    expect(leadTime.status()).toBe(200);

    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 40, lot });
    const seller = await freshSeller(browser, admin, origin, locale, `O Seller ${locale} ${stamp}`);
    const phone = seller.page;
    // The seller needs a vehicle before they can check in against its odometer.
    const vehicle = await aVehicle(admin, origin, 10_000);
    await post(admin, origin, `/vehicles/${vehicle.id}/assign`, { sellerId: seller.id });
    await checkIn(phone, m, { odometer: '10002' });
    const batchId = await batchOf(admin, skuId, lot);
    const load = await post(admin, origin, '/vehicle-loads', { vehicleId: vehicle.id, lines: [{ batchId, packs: 30 }], acknowledgeCeiling: true });
    await post(phone, origin, `/vehicle-loads/${load.id}/confirm`, { version: load.version });

    // Demand: 18 packs sold, which over the 90-day window is 0.2 a day.
    const store = await aStoreByApi(phone, origin, `O Store ${locale} ${stamp}`, { creditMode: 'WEEKLY', creditLimit: '20000.00' });
    await post(phone, origin, '/sales', { storeId: store.id, lines: [{ skuId, packs: 18 }] });

    // The SKU needs a cover before it is forecast at all (OQ-023), and the rollup
    // must know what sold. Both are the Admin's to set up.
    const sku = (await (await admin.request.get(`/api/v1/skus?search=OKRA-PK-5KG`)).json()) as { items: { id: string; version: number }[] };
    const version = sku.items.find((s) => s.id === skuId)?.version ?? 1;
    await admin.request.patch(`/api/v1/skus/${skuId}`, { headers: headers(origin), data: { version, safetyCoverDays: 60 } });
    await post(admin, origin, '/reports/rollup', { days: 2 });

    await admin.goto('/console/reports');
    await expect(admin.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    // RPT-003, RPT-007..010: the five that already have a screen link to it rather than repeat it.
    await expect(admin.getByTestId('report-stock')).toBeVisible();
    await admin.getByTestId('report-reorder').click();
    await admin.waitForURL(/\/console\/reports\/reorder$/);

    // RPT-011: said before the figures, while there is under a year of trading.
    await expect(admin.getByTestId('guide-notice')).toBeVisible();

    const row = admin.getByTestId('reorder-OKRA-PK-5KG');
    await expect(row).toBeVisible();
    // ADR-0026: figures read the same in both languages — Latin digits either way.
    // The exact arithmetic is proved by the core unit tests; what matters here is
    // that the sale reached the demand rate at all, through the rollup.
    await expect(admin.getByTestId('per-day-OKRA-PK-5KG')).not.toHaveText('0.000');

    // A bounded wait: innerText on its own blocks until the whole test times out,
    // which turns a missing testid into eight silent minutes.
    const figure = async (id: string) => {
      const text = await admin.getByTestId(id).innerText({ timeout: 10_000 });
      return Number(text.replace(/[^\d-]/g, ''));
    };
    const near = await figure('projected-OKRA-PK-5KG');

    // RPT-006: the projection is at today plus the lead time, so a longer wait
    // eats more stock. This is the whole point of the report — the same shelf
    // that looks comfortable against a short lead time does not against a long one.
    // 365 is the setting's ceiling; asking for more is refused, so check it landed.
    const stretched = await admin.request.patch('/api/v1/settings', { headers: headers(origin), data: { changes: [{ key: 'imports.lead_time_days', value: 365 }] } });
    expect(stretched.status()).toBe(200);
    await admin.reload();
    await expect(admin.getByTestId('reorder-OKRA-PK-5KG')).toBeVisible();
    const far = await figure('projected-OKRA-PK-5KG');
    expect(far).toBeLessThan(near);

    // RPT-004: short of the cover, the shortfall is what it says to order.
    const [projected, safety, suggested] = await Promise.all([
      figure('projected-OKRA-PK-5KG'), figure('safety-OKRA-PK-5KG'), figure('suggested-OKRA-PK-5KG'),
    ]);
    expect(suggested).toBe(Math.max(safety - projected, 0));
    expect(suggested).toBeGreaterThan(0);

    // RPT-005, PO-008: converting makes a DRAFT the manager edits — nothing is ordered.
    await expect(admin.getByText(m.reports.convertHint)).toBeVisible();
    const vendors = (await (await admin.request.get('/api/v1/vendors')).json()) as { items: { id: string; name: string }[] };
    const vendor = vendors.items[0];
    if (!vendor) throw new Error('no vendor — run pnpm db:seed');
    await admin.getByLabel(m.reports.vendor).selectOption({ label: vendor.name });
    await admin.getByLabel(fill(m.reports.orderPacksFor, { code: 'OKRA-PK-5KG' })).fill(n('50'));
    await admin.getByTestId('convert-to-draft').click();

    await admin.waitForURL(/\/console\/purchase-orders\/[0-9a-f-]{36}$/);
    await expect(admin.getByText(m.procurement.statuses.DRAFT)).toBeVisible();
    // The quantity the manager typed, not the one the system suggested. Displayed
    // figures are Latin in both languages (ADR-0026); only what is typed may be Arabic-Indic.
    await expect(admin.getByText('50', { exact: false }).first()).toBeVisible();

    // RPT-001: what sold shows as a trend, with the month it is compared against.
    await admin.goto('/console/reports/trends');
    await expect(admin.getByTestId('trends-guide')).toBeVisible();
    // I18N-003: the product name renders in the reader's language, so match the
    // row by what it is rather than by an English word.
    await expect(admin.getByTestId(/^trend-/).first()).toBeVisible();
  });
}
