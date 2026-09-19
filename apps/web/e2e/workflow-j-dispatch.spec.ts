import { expect, test, type Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aJpeg, anUpload, aStoreByApi, checkIn, freshSeller, positionsOf, post, receiveStock, sessionPage } from './helpers';

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);

/** Money as whole halalas, and back — prices come from the app, never assumed. */
const halalas = (v: string) => Number(v.replace('.', ''));
const sar = (h: number) => `${Math.floor(h / 100)}.${String(h % 100).padStart(2, '0')}`;

type Order = { id: string; number: string; version: number; status: string; lines: { id: string; code: string; packs: number }[] };
const orderOf = async (page: Page, id: string) => (await (await page.request.get(`/api/v1/dispatch-orders/${id}`)).json()) as Order;

/**
 * Workflow J — requesting a warehouse dispatch (WORKFLOWS.md), in English and
 * Arabic: the seller orders from the phone with the checks of a sale; nothing
 * is billed while it waits; a manager takes it — their name shows — hands it
 * back, and releases it with the transport slip; the stock goes to the
 * dispatched position, never a vehicle; the seller confirms receipt line by
 * line on the owner's word, short one bag; the store pays for what came and
 * the gap is made good by a further order. A second order never arrives: the
 * claim is approved and the stock written off.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  const n = (v: string) => (locale === 'ar' ? v.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d) : v);
  test(`Workflow J (${locale}) — DSP-001..013: an order from the warehouse, handled, released with its slip, received short, and one lost`, async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: false }, { key: 'attendance.restricted_check_in', enabled: false }] } });
    await admin.request.put('/api/v1/discount-ceilings', { headers: headers(origin), data: { orderCeiling: '10', itemCeiling: '5', absoluteMaximum: '25', approvalExpiryMinutes: 30 } });
    const bagLot = `J-${locale}-${stamp}`;
    const { skuId: bagId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 10, lot: bagLot });
    await receiveStock(admin, origin, { code: 'OKRA-PK-1KG', packs: 6, lot: `J1-${locale}-${stamp}` });

    const seller = await freshSeller(browser, admin, origin, locale, `J Seller ${locale} ${stamp}`);
    const phone = seller.page;
    await checkIn(phone, m);
    const store = await aStoreByApi(phone, origin, `J Store ${locale} ${stamp}`, { creditMode: 'WEEKLY', creditLimit: '5000.00' });

    // DSP-001, DSP-002: from the store's page, an order built like a sale — the store's prices.
    const priced = ((await (await phone.request.get(`/api/v1/dispatch-orders/options?storeId=${String(store.id)}`)).json()) as { items: { code: string; unitPrice: string }[] }).items;
    const price = (code: string) => halalas(priced.find((i) => i.code === code)?.unitPrice ?? '0');
    await phone.goto(`/field/stores/${store.id}`);
    await phone.getByRole('link', { name: m.stores.orderFromWarehouse }).click();
    await expect(phone.getByTestId('order-item-OKRA-PK-5KG')).toContainText('90.00');
    await phone.getByLabel(fill(m.sales.packsFor, { code: 'OKRA-PK-5KG' })).fill(n('4'));
    await phone.getByLabel(fill(m.sales.packsFor, { code: 'OKRA-PK-1KG' })).fill(n('2'));
    await expect(phone.getByTestId('order-total')).toContainText(sar(4 * price('OKRA-PK-5KG') + 2 * price('OKRA-PK-1KG')));
    await phone.getByRole('button', { name: m.dispatch.sendOrder }).click();
    await phone.waitForURL(/\/field\/orders\/[0-9a-f-]{36}$/);
    const orderId = phone.url().split('/').at(-1) ?? '';
    await expect(phone.getByTestId('order-status')).toHaveText(m.dispatch.statuses.REQUESTED);
    await expect(phone.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    // DSP-003: pending — the store owes nothing yet.
    const owed = async () => ((await (await phone.request.get(`/api/v1/stores/${String(store.id)}`)).json()) as { credit: { outstanding: string } }).credit.outstanding;
    expect(await owed()).toBe('0.00');

    // DSP-004, DSP-005: a manager takes it — their name shows — and can hand it back.
    const { number } = await orderOf(admin, orderId);
    await admin.goto('/console/dispatch');
    await admin.getByTestId(`order-row-${number}`).getByRole('link').click();
    await admin.getByRole('button', { name: m.dispatch.take, exact: true }).click();
    const me = (await (await admin.request.get('/api/v1/me')).json()) as { name: string };
    await expect(admin.getByTestId('handled-by')).toHaveText(fill(m.dispatch.handledBy, { name: me.name }));
    await phone.reload();
    await expect(phone.getByText(fill(m.dispatch.handledBy, { name: me.name }))).toBeVisible();
    await admin.getByRole('button', { name: m.dispatch.handBack }).click();
    await expect(admin.getByTestId('handled-by')).toHaveText(m.dispatch.nobodyHandling);

    // DSP-006..008: release needs the transport slip; the stock leaves the warehouse, never onto a vehicle.
    await expect(admin.getByRole('button', { name: m.dispatch.release, exact: true })).toBeDisabled();
    await admin.locator('#slip-file').setInputFiles({ name: 'transport-slip.jpg', mimeType: 'image/jpeg', buffer: await aJpeg(admin) });
    await expect(admin.getByTestId('slip-ready')).toBeVisible({ timeout: 30_000 });
    await admin.getByLabel(m.dispatch.transportNote).fill('Al-Majd Transport, truck 4411');
    // FEFO takes the soonest-expiring bags — perhaps another run's — so compare the SKU as a whole.
    const before = await positionsOf(admin, bagId);
    await admin.getByRole('button', { name: m.dispatch.release, exact: true }).click();
    await expect(admin.getByTestId('order-status')).toHaveText(m.dispatch.statuses.RELEASED);
    const after = await positionsOf(admin, bagId);
    expect({ warehouse: before.warehouse - after.warehouse, vehicles: after.vehicles - before.vehicles }).toEqual({ warehouse: 4, vehicles: 0 });

    // DSP-009..011: received on the owner's word, one bag short — line by line.
    await phone.reload();
    await expect(phone.getByTestId('order-status')).toHaveText(m.dispatch.statuses.RELEASED);
    await phone.getByLabel(fill(m.dispatch.receivedFor, { code: 'OKRA-PK-5KG' })).fill(n('3'));
    await phone.getByLabel(fill(m.dispatch.shortFor, { code: 'OKRA-PK-5KG' })).fill(n('1'));
    await phone.getByLabel(m.dispatch.howConfirmed).selectOption('OWNER_WORD');
    await phone.getByRole('button', { name: m.dispatch.confirmReceipt }).click();
    await expect(phone.getByTestId('order-status')).toHaveText(m.dispatch.statuses.DELIVERED);
    const sold = sar(3 * price('OKRA-PK-5KG') + 2 * price('OKRA-PK-1KG'));
    await expect(phone.getByTestId('sold-total')).toContainText(sold);
    expect(await owed()).toBe(sold);

    // DSP-012, OQ-019: the missing bag, by a further order — it opens pre-filled.
    await phone.getByRole('button', { name: m.dispatch.resolutions.FURTHER_ORDER }).click();
    await phone.waitForURL(/\/field\/order\/[0-9a-f-]{36}\?shortfall=/);
    await expect(phone.getByLabel(fill(m.sales.packsFor, { code: 'OKRA-PK-5KG' }))).toHaveValue('1');
    expect((await orderOf(phone, orderId)).status).toBe('CLOSED');

    // DSP-013: a second order never arrives — the seller reports it lost; another person approves; the stock is written off.
    const second = (await post(phone, origin, '/dispatch-orders', { storeId: store.id, lines: [{ skuId: bagId, packs: 1 }] })) as unknown as { orderId: string };
    const toRelease = await orderOf(admin, second.orderId);
    await post(admin, origin, `/dispatch-orders/${toRelease.id}/release`, { version: toRelease.version, transportSlipPhotoId: await anUpload(admin, origin, 'TRANSPORT_SLIP') });
    await phone.goto(`/field/orders/${second.orderId}`);
    await phone.getByRole('button', { name: m.dispatch.nothingArrived }).click();
    await phone.getByLabel(m.dispatch.claimReason).fill('Transporter says delivered; store says nothing came');
    await phone.getByRole('button', { name: m.dispatch.claimLost }).click();
    await expect(phone.getByTestId('claim-pending')).toBeVisible();
    await admin.goto(`/console/dispatch/${second.orderId}`);
    await admin.getByLabel(m.dispatch.comment).fill('Confirmed with the transport company');
    await admin.getByRole('button', { name: m.dispatch.approveClaim }).click();
    await expect(admin.getByTestId('order-status')).toHaveText(m.dispatch.statuses.CLOSED);
    await phone.reload();
    await expect(phone.getByText(m.dispatch.closeReasons.LOST, { exact: true })).toBeVisible();
    expect(await owed()).toBe(sold);
  });
}
