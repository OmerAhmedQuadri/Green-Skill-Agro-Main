import { expect, test, type Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aStoreByApi, aVehicle, batchOf, checkIn, freshSeller, post, receiveStock, sessionPage } from './helpers';

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);

const salesOf = async (phone: Page, storeId: string) =>
  ((await (await phone.request.get(`/api/v1/sales?storeId=${storeId}`)).json()) as { items: { id: string; status: string }[] }).items;

/**
 * Workflow I — recording a sale (WORKFLOWS.md), in English and Arabic, on a
 * phone with a camera and GPS and in the console: credit first, live vehicle
 * stock at the store's price, the tighter ceiling, manager approval above it
 * (approve lower, and reject then a fresh sale), bill to bill, the delivery
 * document shared from the phone, an override for one sale, and a double tap
 * on a dropped connection that still makes one sale.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  // An Arabic keyboard types Arabic-Indic digits (ADR-0026).
  const n = (v: string) => (locale === 'ar' ? v.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d) : v);
  test(`Workflow I (${locale}) — SAL-001..011, PRC-008..017, DOC-001..005, CRD-005, CRD-007: a sale on the phone, approval in the console, the delivery document`, async ({ browser, baseURL }) => {
    test.setTimeout(360_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const lot = `I-${locale}-${stamp}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);

    // The rules this run relies on, set explicitly: 10% order ceiling, 5% per item, 25% at most; stores active on onboarding.
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: false }, { key: 'attendance.restricted_check_in', enabled: false }] } });
    await admin.request.put('/api/v1/discount-ceilings', { headers: headers(origin), data: { orderCeiling: '10', itemCeiling: '5', absoluteMaximum: '25', approvalExpiryMinutes: 30 } });
    await admin.request.patch('/api/v1/settings', { headers: headers(origin), data: { changes: [
      { key: 'documents.sending', value: 'OPTIONAL' }, { key: 'credit.weekly_enabled', value: true }, { key: 'credit.bill_to_bill_enabled', value: true },
    ] } });
    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 12, lot });
    await admin.request.put(`/api/v1/skus/${skuId}/discount-ceiling`, { headers: headers(origin), data: { ceiling: null } });

    // A seller with the vehicle, checked in, 12 bags of Okra confirmed onto it.
    const seller = await freshSeller(browser, admin, origin, locale, `I Seller ${locale} ${stamp}`);
    const phone = seller.page;
    // OQ-007: the phone's share sheet, recorded instead of opened.
    await phone.context().addInitScript(() => {
      const shared: string[][] = [];
      Object.assign(window, { sharedFiles: shared });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d?: ShareData) => Boolean(d?.files?.length) });
      Object.defineProperty(navigator, 'share', { configurable: true, value: (d: ShareData) => { shared.push((d.files ?? []).map((f) => f.name)); return Promise.resolve(); } });
    });
    const vehicle = await aVehicle(admin, origin, 10_000);
    await post(admin, origin, `/vehicles/${vehicle.id}/assign`, { sellerId: seller.id });
    await checkIn(phone, m, { odometer: '10002' });
    const load = await post(admin, origin, '/vehicle-loads', { vehicleId: vehicle.id, lines: [{ batchId: await batchOf(admin, skuId, lot), packs: 12 }], acknowledgeCeiling: true });
    await post(phone, origin, `/vehicle-loads/${load.id}/confirm`, { version: load.version });

    const credit = await aStoreByApi(phone, origin, `I Weekly ${locale} ${stamp}`, { creditMode: 'WEEKLY', creditLimit: '1000.00' });
    const cash = await aStoreByApi(phone, origin, `I Cash ${locale} ${stamp}`, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    const blocked = await aStoreByApi(phone, origin, `I Blocked ${locale} ${stamp}`, { creditMode: 'WEEKLY', creditLimit: '1000.00' });
    await post(admin, origin, `/stores/${blocked.id}/adjustments`, { amount: '100.00', reason: 'Opening balance', dueOn: '2026-01-15' });

    // SAL-001, SAL-002, CRD-005: a blocked store shows the block and the reason — and nothing can be added.
    await phone.goto(`/field/stores/${blocked.id}`);
    await phone.getByRole('link', { name: m.stores.newSale }).click();
    await expect(phone.getByTestId('credit-blocked')).toContainText(m.stores.blocked);
    await expect(phone.getByTestId('cannot-sell')).toBeVisible();
    await expect(phone.locator('[data-testid^="item-"]')).toHaveCount(0);
    await expect(phone.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');

    // SAL-003, SAL-004: live vehicle stock, in whole packs, at the store's price.
    await phone.goto(`/field/sell/${credit.id}`);
    const bag = phone.getByTestId('item-OKRA-PK-5KG');
    await expect(bag).toContainText(fill(m.sales.sellable, { count: 12 }));
    await expect(bag).toContainText('90.00');

    // SAL-011: a double tap while the first response is lost on the way back — one sale.
    let dropped = false;
    await phone.route('**/api/v1/sales', async (route) => {
      if (route.request().method() === 'POST' && !dropped) {
        dropped = true;
        await route.fetch(); // the server records the sale…
        await route.abort('internetdisconnected'); // …and the phone never hears back
      } else await route.continue();
    });
    await phone.getByLabel(fill(m.sales.packsFor, { code: 'OKRA-PK-5KG' })).fill(n('1'));
    await expect(phone.getByTestId('total')).toContainText('90.00');
    await phone.getByRole('button', { name: m.sales.complete }).dblclick();
    await phone.waitForURL(/\/field\/sales\/[0-9a-f-]{36}$/);
    await phone.unroute('**/api/v1/sales');
    expect(dropped).toBe(true);
    expect(await salesOf(phone, credit.id)).toHaveLength(1);
    await expect(phone.getByTestId('sale-status')).toHaveText(m.sales.statuses.COMPLETED);

    // DOC-001..005: the document is printed, marked not a tax invoice, shared from the phone, and kept.
    await expect(phone.getByTestId('delivery-document')).toContainText(m.sales.notTaxInvoice);
    await expect(phone.getByRole('button', { name: m.sales.share })).toBeVisible({ timeout: 60_000 });
    const number = (await phone.getByTestId('document-number').textContent()) ?? '';
    expect(number).toMatch(/^DN-\d{4}-\d{6}$/);
    const pdf = await phone.request.get(`${phone.url().replace('/field/sales/', '/api/v1/sales/')}/delivery-document`);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    await phone.getByRole('button', { name: m.sales.share }).click();
    await expect(phone.getByTestId('document-sends')).toBeVisible();
    expect(await phone.evaluate(() => (window as unknown as { sharedFiles: string[][] }).sharedFiles)).toEqual([[`${number}.pdf`]]);

    // SAL-005, PRC-006, PRC-009: 12% is above the tighter (5%) ceiling — the seller asks, with a reason, and waits.
    await phone.goto(`/field/sell/${credit.id}`);
    await phone.getByLabel(fill(m.sales.packsFor, { code: 'OKRA-PK-5KG' })).fill(n('4'));
    await phone.getByLabel(fill(m.sales.discountFor, { code: 'OKRA-PK-5KG' })).fill(n('12'));
    await expect(phone.getByTestId('above-OKRA-PK-5KG')).toBeVisible();
    await expect(phone.getByRole('button', { name: m.sales.complete })).toHaveCount(0);
    await phone.getByLabel(m.sales.requestReason).fill('Matching a competitor');
    await phone.getByRole('button', { name: m.sales.requestApproval }).click();
    await phone.waitForURL(/\/field\/sales\/[0-9a-f-]{36}$/);
    const pendingId = phone.url().split('/').at(-1) ?? '';
    await expect(phone.getByTestId('waiting')).toBeVisible();
    // PRC-010, PRC-011: nothing posted, the 4 bags held.
    const held = (await (await phone.request.get('/api/v1/stock/my-vehicle')).json()) as { packs: number; batches: { heldPacks: number }[] };
    expect({ packs: held.packs, held: held.batches.reduce((s, b) => s + b.heldPacks, 0) }).toEqual({ packs: 11, held: 4 });

    // PRC-012, PRC-013: the approver — notified — lowers it to 8% with a comment.
    await admin.goto('/console/sales');
    await admin.getByRole('row').filter({ hasText: String(credit.name) }).getByRole('link').click();
    await admin.getByLabel(fill(m.sales.approvedFor, { code: 'OKRA-PK-5KG' })).fill(n('8'));
    await admin.getByLabel(m.sales.comment).fill('Eight is the most this season');
    await admin.getByRole('button', { name: m.sales.approve, exact: true }).click();
    await expect(admin.getByTestId('sale-status')).toHaveText(m.sales.statuses.DISCOUNT_APPROVED);

    // PRC-014: the seller sees it without reloading and completes at the approved discount.
    await expect(phone.getByTestId('approved')).toContainText(m.sales.reducedTitle, { timeout: 15_000 });
    await phone.getByRole('button', { name: m.sales.complete }).click();
    await expect(phone.getByTestId('sale-status')).toHaveText(m.sales.statuses.COMPLETED);
    await expect(phone.getByTestId('sale-total')).toContainText('331.20');

    // PRC-014: rejected — the sale closes, the stock is released, and a fresh sale within the ceiling is offered, pre-filled.
    await phone.goto(`/field/sell/${credit.id}`);
    await phone.getByLabel(fill(m.sales.packsFor, { code: 'OKRA-PK-5KG' })).fill(n('2'));
    await phone.getByLabel(fill(m.sales.discountFor, { code: 'OKRA-PK-5KG' })).fill(n('15'));
    await phone.getByLabel(m.sales.requestReason).fill('Asked for more');
    await phone.getByRole('button', { name: m.sales.requestApproval }).click();
    await phone.waitForURL((url) => url.pathname.startsWith('/field/sales/') && !url.pathname.endsWith(pendingId));
    const rejected = await post(admin, origin, `/discount-approvals/${phone.url().split('/').at(-1) ?? ''}/decide`,
      { version: 1, approve: false, comment: 'Too deep for this store' });
    expect(rejected.status).toBe('CANCELLED');
    await expect(phone.getByTestId('cancelled')).toContainText(m.sales.cancelledTitles.REJECTED, { timeout: 15_000 });
    await phone.getByRole('link', { name: m.sales.freshSale }).click();
    await expect(phone.getByLabel(fill(m.sales.discountFor, { code: 'OKRA-PK-5KG' }))).toHaveValue('5');
    await expect(phone.getByTestId('total')).toContainText('171.00');
    await phone.getByRole('button', { name: m.sales.complete }).click();
    await expect(phone.getByTestId('sale-status')).toHaveText(m.sales.statuses.COMPLETED);

    // SAL-006: bill to bill settles at once — in cash, which becomes cash in hand (SAL-007).
    await phone.goto(`/field/sell/${cash.id}`);
    await phone.getByLabel(fill(m.sales.packsFor, { code: 'OKRA-PK-5KG' })).fill(n('1'));
    await expect(phone.getByText(m.sales.billToBillNote)).toBeVisible();
    await phone.getByRole('button', { name: m.sales.complete }).click();
    await expect(phone.getByTestId('sale-status')).toHaveText(m.sales.statuses.COMPLETED);
    await expect(phone.getByTestId('paid')).toContainText(m.stores.methods.CASH);

    // SAL-009, CRD-007: a manager releases the blocked store for one sale, with a reason; the next is blocked again.
    await post(admin, origin, `/stores/${blocked.id}/credit-overrides`, { reason: 'Owner pays on Thursday' });
    await phone.goto(`/field/sell/${blocked.id}`);
    await expect(phone.getByTestId('released')).toBeVisible();
    await phone.getByLabel(fill(m.sales.packsFor, { code: 'OKRA-PK-5KG' })).fill(n('1'));
    await phone.getByRole('button', { name: m.sales.complete }).click();
    await expect(phone.getByTestId('sale-status')).toHaveText(m.sales.statuses.COMPLETED);
    await phone.goto(`/field/sell/${blocked.id}`);
    await expect(phone.getByTestId('cannot-sell')).toBeVisible();

    // SAL-007: the vehicle is down 1 + 4 + 2 + 1 + 1 bags; the cycle store owes its sales; cash in hand is the cash sale;
    // workflow G: the home screen shows what the stores owe.
    const after = (await (await phone.request.get('/api/v1/stock/my-vehicle')).json()) as { packs: number };
    expect(after.packs).toBe(3);
    const store = (await (await phone.request.get(`/api/v1/stores/${credit.id}`)).json()) as { credit: { outstanding: string } };
    expect(store.credit.outstanding).toBe('592.20');
    await phone.goto('/field/today');
    await expect(phone.getByTestId('cash-in-hand')).toContainText('90.00');
    // 592.20 on the weekly store; 100.00 opening balance and 90.00 released sale on the other.
    await expect(phone.getByTestId('dues-card')).toContainText('782.20');
    await expect(phone.getByTestId('dues-card')).toContainText('100.00');
  });
}
