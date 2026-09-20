import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { anUpload, aStoreByApi, aVehicle, batchOf, checkIn, freshSeller, positionsOf, post, receiveStock, sessionPage } from './helpers';

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);

/**
 * Workflow N — auditing vehicle stock (WORKFLOWS.md), in English and Arabic:
 * a manager counts what is really on a vehicle, batch by batch; a difference
 * cannot pass without a comment; closing raises a write-off for what is short
 * and holds what is extra for another manager to approve; the vehicle stops
 * showing as due an audit; and a delivery confirmed on the store owner's word
 * is listed for review.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  const n = (v: string) => (locale === 'ar' ? v.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d) : v);
  test(`Workflow N (${locale}) — VEH-011..015, DSP-010: a vehicle counted, a shortfall written off and a surplus approved`, async ({ browser, baseURL }) => {
    test.setTimeout(480_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const lot = `N-${locale}-${stamp}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    const second = await sessionPage(browser, 'manager@dev.local', locale, origin);
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: false }, { key: 'attendance.restricted_check_in', enabled: false }] } });
    await admin.request.patch('/api/v1/settings', { headers: headers(origin), data: { changes: [{ key: 'audits.interval_days', value: 30 }] } });
    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 8, lot });

    const seller = await freshSeller(browser, admin, origin, locale, `N Seller ${locale} ${stamp}`);
    const phone = seller.page;
    const vehicle = await aVehicle(admin, origin, 10_000);
    await post(admin, origin, `/vehicles/${vehicle.id}/assign`, { sellerId: seller.id });
    await checkIn(phone, m, { odometer: '10002' });
    const batchId = await batchOf(admin, skuId, lot);
    const load = await post(admin, origin, '/vehicle-loads', { vehicleId: vehicle.id, lines: [{ batchId, packs: 8 }], acknowledgeCeiling: true });
    await post(phone, origin, `/vehicle-loads/${load.id}/confirm`, { version: load.version });

    // VEH-015: a vehicle nobody has counted is due an audit.
    await admin.goto('/console/audits');
    await expect(admin.getByTestId(`overdue-${vehicle.registration}`)).toBeVisible();
    await expect(admin.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');

    // VEH-011, VEH-014: the count opens against the vehicle and its seller.
    await admin.getByLabel(m.audits.vehicle).selectOption({ label: vehicle.registration });
    await admin.getByRole('button', { name: m.audits.startAudit }).click();
    await admin.waitForURL(/\/console\/audits\/[0-9a-f-]{36}$/);
    await expect(admin.getByTestId('audit-status')).toHaveText(m.audits.statuses.IN_PROGRESS);
    await expect(admin.getByText(fill(m.audits.seller, { name: seller.name }))).toBeVisible();
    const line = admin.getByTestId('audit-line-OKRA-PK-5KG');
    // ADR-0026: figures read the same in both languages; only what is typed may be Arabic-Indic.
    await expect(admin.getByTestId('system-OKRA-PK-5KG')).toHaveText('8');

    // VEH-012: a difference cannot pass without a comment.
    const counted = admin.getByLabel(fill(m.audits.countedFor, { code: 'OKRA-PK-5KG', lot }));
    await counted.fill(n('6'));
    await admin.getByRole('button', { name: m.audits.saveCount }).click();
    await admin.getByRole('button', { name: m.audits.close }).click();
    await expect(admin.getByText(m.errors.REASON_REQUIRED)).toBeVisible();

    // VEH-013: with a comment it closes, and the two missing bags become a write-off to approve.
    await admin.getByLabel(fill(m.audits.commentFor, { code: 'OKRA-PK-5KG', lot })).fill(`Two bags missing ${lot}`);
    await admin.getByRole('button', { name: m.audits.saveCount }).click();
    await admin.getByRole('button', { name: m.audits.close }).click();
    await expect(admin.getByTestId('audit-status')).toHaveText(m.audits.statuses.CLOSED);
    await expect(line).toContainText(m.audits.outcomes.SHORTFALL);
    const before = await positionsOf(admin, skuId); // closing moves nothing by itself
    // Four-eyes: the manager who closed the audit submitted the write-off, so another one decides it.
    await second.goto('/console/write-offs');
    const request = second.getByRole('row').filter({ hasText: `Two bags missing ${lot}` });
    await expect(request).toContainText(m.warehouse.statuses.SUBMITTED);
    await request.getByRole('button', { name: m.warehouse.decide }).click();
    await second.getByRole('button', { name: m.warehouse.approve, exact: true }).click();
    await expect.poll(async () => (await positionsOf(admin, skuId)).vehicles).toBe(before.vehicles - 2);

    // VEH-015: counted, so the vehicle is no longer due.
    await admin.goto('/console/audits');
    await expect(admin.getByTestId(`overdue-${vehicle.registration}`)).toHaveCount(0);

    // OQ-022: a second count finds three more than the system says — another manager decides.
    await admin.getByLabel(m.audits.vehicle).selectOption({ label: vehicle.registration });
    await admin.getByRole('button', { name: m.audits.startAudit }).click();
    await admin.waitForURL(/\/console\/audits\/[0-9a-f-]{36}$/);
    const surplusUrl = admin.url();
    await admin.getByLabel(fill(m.audits.countedFor, { code: 'OKRA-PK-5KG', lot })).fill(n('9'));
    await admin.getByLabel(fill(m.audits.commentFor, { code: 'OKRA-PK-5KG', lot })).fill(`Three bags found ${lot}`);
    await admin.getByRole('button', { name: m.audits.saveCount }).click();
    await admin.getByRole('button', { name: m.audits.close }).click();
    await expect(admin.getByTestId('surplus-OKRA-PK-5KG')).toContainText(m.audits.surplusStatuses.PENDING);
    const held = (await positionsOf(admin, skuId)).vehicles;

    // The manager who closed it cannot approve it; another one can.
    await admin.getByTestId('approve-surplus-OKRA-PK-5KG').click();
    await expect(admin.getByText(m.errors.FOUR_EYES)).toBeVisible();
    await second.goto(surplusUrl);
    await second.getByTestId('approve-surplus-OKRA-PK-5KG').click();
    await expect(second.getByTestId('surplus-OKRA-PK-5KG')).toContainText(m.audits.surplusStatuses.APPROVED);
    expect((await positionsOf(admin, skuId)).vehicles).toBe(held + 3);

    // DSP-010: a delivery confirmed on the owner's word is listed with the audit for review.
    const order = (await post(phone, origin, '/dispatch-orders', { storeId: (await aStoreByApi(phone, origin, `N Store ${locale} ${stamp}`, { creditMode: 'WEEKLY', creditLimit: '5000.00' })).id, lines: [{ skuId, packs: 1 }] })) as unknown as { orderId: string };
    const toRelease = (await (await admin.request.get(`/api/v1/dispatch-orders/${order.orderId}`)).json()) as { id: string; version: number; lines: { id: string; packs: number }[] };
    await post(admin, origin, `/dispatch-orders/${toRelease.id}/release`, { version: toRelease.version, transportSlipPhotoId: await anUpload(admin, origin, 'TRANSPORT_SLIP') });
    const released = (await (await phone.request.get(`/api/v1/dispatch-orders/${order.orderId}`)).json()) as { version: number; lines: { id: string; packs: number }[] };
    await post(phone, origin, `/dispatch-orders/${order.orderId}/confirm-receipt`, {
      version: released.version, mode: 'OWNER_WORD', lines: released.lines.map((l) => ({ lineId: l.id, received: l.packs, short: 0, damaged: 0 })),
    });
    await admin.goto(surplusUrl);
    await expect(admin.getByText(m.audits.remoteTitle)).toBeVisible();
  });
}
