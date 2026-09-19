import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { anUpload, aStoreByApi, checkIn, freshSeller, post, receiveStock, sessionPage } from './helpers';

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);

/**
 * Workflow K — creating an order on a seller's behalf (WORKFLOWS.md), in
 * English and Arabic: a manager raises an order for a store in the console;
 * it is the store's seller's sale, the seller is told at once, and it is
 * released and confirmed as in workflow J — then it is the seller's sale.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Workflow K (${locale}) — DSP-015, DSP-016, DSP-017: a manager orders for a seller's store; the seller is told and confirms it`, async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: false }, { key: 'attendance.restricted_check_in', enabled: false }] } });
    await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 4, lot: `K-${locale}-${stamp}` });
    const seller = await freshSeller(browser, admin, origin, locale, `K Seller ${locale} ${stamp}`);
    const phone = seller.page;
    const storeName = `K Store ${locale} ${stamp}`;
    await aStoreByApi(phone, origin, storeName, { creditMode: 'WEEKLY', creditLimit: '5000.00' });

    // DSP-015: in the console, for the store — it will be the seller's sale.
    await admin.goto('/console/dispatch/new');
    await admin.getByLabel(m.dispatch.findStore).fill(storeName);
    await admin.getByLabel(m.dispatch.store, { exact: true }).selectOption({ label: `${storeName} — ${seller.name}` });
    await expect(admin.getByTestId('attributed-to')).toHaveText(fill(m.dispatch.attributedTo, { name: seller.name }));
    await admin.getByLabel(fill(m.sales.packsFor, { code: 'OKRA-PK-5KG' })).fill('2');
    await admin.getByRole('button', { name: m.dispatch.sendOrder }).click();
    await admin.waitForURL(/\/console\/dispatch\/[0-9a-f-]{36}$/);
    const orderId = admin.url().split('/').at(-1) ?? '';
    const me = (await (await admin.request.get('/api/v1/me')).json()) as { name: string };
    await expect(admin.getByText(fill(m.dispatch.raisedByLine, { name: me.name }), { exact: true })).toBeVisible();

    // DSP-016: the seller is told at once — the bell carries it.
    const mine = (await (await phone.request.get('/api/v1/notifications')).json()) as { items: { kind: string; link: string | null }[] };
    expect(mine.items.find((x) => x.kind === 'DISPATCH_CREATED_FOR_YOU')?.link).toBe(`/field/orders/${orderId}`);

    // DSP-017: released as in J; the seller confirms receipt as for their own order.
    const order = (await (await admin.request.get(`/api/v1/dispatch-orders/${orderId}`)).json()) as { version: number };
    await post(admin, origin, `/dispatch-orders/${orderId}/release`, { version: order.version, transportSlipPhotoId: await anUpload(admin, origin, 'TRANSPORT_SLIP') });
    await checkIn(phone, m);
    await phone.goto(`/field/orders/${orderId}`);
    await expect(phone.getByTestId('for-seller')).toBeVisible();
    await expect(phone.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await phone.getByRole('button', { name: m.dispatch.confirmReceipt }).click();
    await expect(phone.getByTestId('order-status')).toHaveText(m.dispatch.statuses.CLOSED);
    // It is the seller's sale — in their list, completed; target progress is derived from it in M11.
    const sales = (await (await phone.request.get('/api/v1/sales')).json()) as { items: { status: string; total: string; dispatchOrderId: string | null }[] };
    expect(sales.items.find((x) => x.dispatchOrderId === orderId)).toMatchObject({ status: 'COMPLETED', total: '180.00' });
  });
}
