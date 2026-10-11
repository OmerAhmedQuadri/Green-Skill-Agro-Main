import { expect, test, type Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aVehicle, batchOf, checkIn, freshSeller, post, receiveStock, sessionPage, takePhoto } from './helpers';

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);
const setOpenSales = (admin: Page, origin: string, on: boolean) =>
  admin.request.patch('/api/v1/settings', { headers: headers(origin), data: { changes: [{ key: 'sales.open_sales_on', value: on }, { key: 'sales.open_sale_limit', value: '500.00' }] } });

/**
 * Open sales (ADR-0052), in English and Arabic: a seller on the road sells to
 * a buyer who is not a store — paid in full, a simplified delivery record.
 * Switched off, the seller asks; the Admin finds it on the dashboard, approves
 * it, and the seller completes it, paid in full.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  // An Arabic keyboard types Arabic-Indic digits (ADR-0026).
  const n = (v: string) => (locale === 'ar' ? v.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d) : v);
  test(`Open sales (${locale}) — SAL-012..017: paid in full on the phone; switched off, approved in the console and completed`, async ({ browser, baseURL }) => {
    test.setTimeout(360_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const lot = `OS-${locale}-${stamp}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.setViewportSize({ width: 1440, height: 900 });
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'attendance.restricted_check_in', enabled: false }] } });
    await admin.request.put('/api/v1/discount-ceilings', { headers: headers(origin), data: { orderCeiling: '10', itemCeiling: '5', absoluteMaximum: '25', approvalExpiryMinutes: 30 } });
    await setOpenSales(admin, origin, true);
    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 6, lot });

    const seller = await freshSeller(browser, admin, origin, locale, `OS Seller ${locale} ${stamp}`);
    const phone = seller.page;
    const vehicle = await aVehicle(admin, origin, 10_000);
    await post(admin, origin, `/vehicles/${vehicle.id}/assign`, { sellerId: seller.id });
    await checkIn(phone, m, { odometer: '10002' });
    const load = await post(admin, origin, '/vehicle-loads', { vehicleId: vehicle.id, lines: [{ batchId: await batchOf(admin, skuId, lot), packs: 6 }], acknowledgeCeiling: true });
    await post(phone, origin, `/vehicle-loads/${load.id}/confirm`, { version: load.version });

    // SAL-012, SAL-013: from My sales, for a buyer who is not a store — the place found, the whole total paid now.
    await phone.goto('/field/sales');
    await phone.getByTestId('new-open-sale').click();
    await expect(phone).toHaveURL(/\/field\/sell\/open$/);
    await expect(phone.getByTestId('location')).toContainText(m.stores.locationFound.split('{')[0]?.trim() ?? '');
    await phone.getByLabel(m.sales.open.buyerName).fill('Abu Khalid');
    await phone.getByLabel(fill(m.sales.packsFor, { code: 'OKRA-PK-5KG' })).fill(n('2'));
    await expect(phone.getByTestId('total')).toContainText('180.00');
    await expect(phone.getByTestId('open-full-amount')).toContainText('180.00');
    await phone.getByLabel(m.stores.voucherNumber).fill(`OS-${locale}-${stamp}`);
    await takePhoto(phone, 'open-voucher-photo', m);
    await phone.getByRole('button', { name: m.sales.complete }).click();
    await expect(phone).toHaveURL(/\/field\/sales\/[0-9a-f-]{36}$/);
    await expect(phone.getByRole('heading', { name: fill(m.sales.open.titleWith, { buyer: 'Abu Khalid' }) })).toBeVisible();
    await expect(phone.getByTestId('sale-status')).toHaveText(m.sales.statuses.COMPLETED);
    // SAL-017, SAL-018: its paper is the simplified record, and it is never returned.
    await expect(phone.getByText(m.sales.open.documentTitle, { exact: true })).toBeVisible();
    await expect(phone.getByText(m.sales.open.notReturnable)).toBeVisible();

    // SAL-015, SAL-016: switched off, the seller asks — with a reason — and waits.
    await setOpenSales(admin, origin, false);
    await phone.goto('/field/sell/open');
    await expect(phone.getByTestId('open-switched-off')).toBeVisible();
    await phone.getByLabel(fill(m.sales.packsFor, { code: 'OKRA-PK-5KG' })).fill(n('1'));
    await expect(phone.getByTestId('open-request')).toContainText(m.sales.open.grounds.SWITCHED_OFF);
    await phone.getByLabel(m.sales.open.requestReason).fill('Farmer at the roadside');
    await phone.getByRole('button', { name: m.sales.requestApproval }).click();
    await expect(phone).toHaveURL(/\/field\/sales\/[0-9a-f-]{36}$/);
    const saleId = phone.url().split('/').at(-1) ?? '';
    await expect(phone.getByTestId('waiting')).toContainText(m.sales.open.waitingTitle);

    // The Admin finds it under "Waiting for a decision", and approves it as it stands.
    await admin.goto('/console/dashboard');
    await admin.getByTestId('waiting-OPEN_SALES').click();
    await expect(admin).toHaveURL(/\/console\/sales\?status=AWAITING$/);
    await admin.goto(`/console/sales/${saleId}`);
    await expect(admin.getByTestId('open-grounds')).toContainText(m.sales.open.grounds.SWITCHED_OFF);
    await admin.getByRole('button', { name: m.sales.open.approveOpen }).click();
    await expect(admin.getByTestId('sale-status')).toHaveText(m.sales.statuses.DISCOUNT_APPROVED);

    // Approved, the seller completes it — paid in full, nothing to type but the voucher.
    await phone.reload();
    await expect(phone.getByTestId('approved')).toContainText(m.sales.open.approvedTitle);
    await expect(phone.getByTestId('complete-full-amount')).toContainText('90.00');
    await phone.getByLabel(m.stores.voucherNumber).fill(`OS2-${locale}-${stamp}`);
    await takePhoto(phone, 'complete-voucher-photo', m);
    await phone.getByRole('button', { name: m.sales.complete }).click();
    await expect(phone.getByTestId('sale-status')).toHaveText(m.sales.statuses.COMPLETED);

    await setOpenSales(admin, origin, true);
  });
}
