import { expect, test, type Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { batchOf, batchPositions, freshSeller, receiveStock, sessionPage, takePhoto } from './helpers';

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);

/** Check in on the phone: location, selfie, odometer photo and reading (ATT-001). */
async function checkIn(phone: Page, m: typeof en, odometer: string) {
  await phone.goto('/field/today');
  await phone.getByRole('button', { name: m.field.checkIn, exact: true }).click();
  await expect(phone.getByTestId('location')).toContainText(m.field.locationFound.split(' (')[0] ?? '');
  await takePhoto(phone, 'in-selfie', m);
  await takePhoto(phone, 'in-odometer', m);
  await phone.getByLabel(m.field.odometerReading).fill(odometer);
  await phone.getByRole('button', { name: m.field.checkIn, exact: true }).click();
  await expect(phone.getByTestId('day-card')).toContainText(m.field.status.OPEN);
}

/**
 * Workflow F — assigning a vehicle and issuing stock (WORKFLOWS.md), in
 * English and Arabic: the manager registers and assigns a vehicle, builds a
 * load from FEFO-proposed batches, is warned over the ceiling; the seller
 * disputes and then confirms on their phone; reassignment is a handover both
 * sellers confirm.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Workflow F (${locale}) — VEH-002, 005..009: assign, load with FEFO and a ceiling warning, confirm on the phone, hand over`, async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const early = `FE-${locale}-${stamp}`;
    const late = `FL-${locale}-${stamp}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 10, lot: late, expiresOn: '2029-11-30' });
    await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 10, lot: early, expiresOn: '2029-06-30' });
    const sellerA = await freshSeller(browser, admin, origin, locale, `F Seller A ${locale} ${stamp}`);
    const sellerB = await freshSeller(browser, admin, origin, locale, `F Seller B ${locale} ${stamp}`);
    // VEH-006: a ceiling this seller's first load will exceed.
    await admin.request.put('/api/v1/ceilings', { headers: { origin, 'idempotency-key': crypto.randomUUID() }, data: { kind: 'VEHICLE_STOCK_VALUE', sellerId: sellerA.id, amount: '100.00' } });

    // VEH-001: register the vehicle.
    const registration = `F${locale.toUpperCase()} ${stamp}`;
    await admin.goto('/console/vehicles');
    await admin.getByRole('button', { name: m.vehicles.add }).first().click();
    await admin.getByLabel(m.vehicles.registration).fill(registration);
    await admin.getByLabel(m.vehicles.description).fill('Isuzu D-Max');
    await admin.getByLabel(m.vehicles.odometerKm).fill('12000');
    await admin.getByRole('button', { name: m.vehicles.create }).click();
    await admin.waitForURL(/\/console\/vehicles\/[0-9a-f-]{36}$/);
    const vehicleId = admin.url().split('/').at(-1) ?? '';
    await expect(admin.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');

    // VEH-002: assign it; the assignment is dated and kept.
    await admin.getByLabel(m.vehicles.assignTo).selectOption(sellerA.id);
    await admin.getByRole('button', { name: m.vehicles.assign, exact: true }).click();
    await expect(admin.getByText(m.vehicles.assigned)).toBeVisible();
    await expect(admin.getByRole('row').filter({ hasText: sellerA.name })).toContainText(m.vehicles.current);

    // The seller's day must be open to receive stock (ATT-010).
    await checkIn(sellerA.page, m, '12004');

    // VEH-005: build the load; batches are proposed first expiry first out, a flagged one on top.
    await admin.getByRole('button', { name: m.vehicles.newLoad }).first().click();
    await admin.getByLabel(m.vehicles.sku).selectOption(skuId);
    await admin.getByLabel(m.vehicles.packsWanted).fill('5');
    await admin.getByRole('button', { name: m.vehicles.propose }).click();
    await expect(admin.getByTestId(`proposed-${early}`)).toBeVisible();
    await expect(admin.getByTestId(`proposed-${late}`)).toBeVisible();
    const rowIndex = async (lot: string) => admin.locator('[data-testid^="proposed-"]').evaluateAll((rows, l) => rows.findIndex((r) => r.getAttribute('data-testid') === `proposed-${l}`), lot);
    expect(await rowIndex(early)).toBeGreaterThanOrEqual(0);
    expect(await rowIndex(early)).toBeLessThan(await rowIndex(late));
    await admin.request.put(`/api/v1/batches/${await batchOf(admin, skuId, late)}/clearance-priority`, {
      headers: { origin, 'idempotency-key': crypto.randomUUID() }, data: { prioritised: true, note: `Clear ${late}` },
    });
    await admin.getByRole('button', { name: m.vehicles.propose }).click();
    await expect(admin.getByTestId(`proposed-${late}`)).toContainText(m.vehicles.flagged);
    await expect.poll(async () => (await rowIndex(late)) < (await rowIndex(early))).toBe(true);
    // The manager may change the proposal: 4 from the early batch, 1 from the flagged one, nothing else.
    for (const input of await admin.getByLabel(new RegExp(fill(m.vehicles.packsFrom, { lot: '' }))).all()) await input.fill('');
    await admin.getByLabel(fill(m.vehicles.packsFrom, { lot: early })).fill('4');
    await admin.getByLabel(fill(m.vehicles.packsFrom, { lot: late })).fill('1');

    // VEH-006: over the ceiling it warns first; acknowledged, it goes ahead.
    await admin.getByRole('button', { name: m.vehicles.issueLoad }).click();
    await expect(admin.getByTestId('ceiling-warning')).toBeVisible();
    await admin.getByRole('button', { name: m.vehicles.issueAnyway }).click();
    const loadRow = admin.locator('[data-testid^="console-load-VL-"]').first();
    await expect(loadRow).toContainText(m.vehicles.loadStatuses.ISSUED);
    await expect(loadRow).toContainText(m.vehicles.overCeiling);
    expect(await batchPositions(admin, skuId, early)).toEqual({ warehouse: 10, vehicles: 0, total: 10 }); // held, not moved

    // VEH-007: the seller is notified and disputes on their phone.
    const phoneA = sellerA.page;
    await phoneA.goto('/field/vehicle');
    await expect(phoneA.getByTestId('unread-count')).toBeVisible({ timeout: 40_000 });
    const card = phoneA.locator('[data-testid^="load-VL-"]').first();
    await card.getByRole('button', { name: m.field.disputeLoad }).click();
    await phoneA.getByLabel(m.field.disputeComment).fill('Only the early bags are here');
    await phoneA.getByRole('button', { name: m.field.sendDispute }).click();
    await expect(card).toContainText(m.field.loadStatus.DISPUTED);

    // The manager amends — dropping the flagged batch — and issues again.
    await admin.reload();
    await expect(loadRow).toContainText('Only the early bags are here');
    await loadRow.getByRole('button', { name: m.vehicles.amend }).click();
    await loadRow.getByLabel(fill(m.vehicles.packsFrom, { lot: late })).fill('0');
    await loadRow.getByRole('button', { name: m.vehicles.reissue }).click();
    const anyway = admin.getByRole('button', { name: m.vehicles.issueAnyway });
    await expect(anyway.or(loadRow.getByText(m.vehicles.loadStatuses.ISSUED))).toBeVisible();
    if (await anyway.isVisible()) await anyway.click();
    await expect(loadRow).toContainText(m.vehicles.loadStatuses.ISSUED);

    // VEH-007, VEH-008: the seller confirms; warehouse down, vehicle up, total unchanged.
    await phoneA.reload();
    await card.getByRole('button', { name: m.field.confirmLoad }).click();
    await expect(phoneA.getByTestId(`batch-${early}`)).toBeVisible();
    await expect.poll(() => batchPositions(admin, skuId, early)).toEqual({ warehouse: 6, vehicles: 4, total: 10 });

    // VEH-009: reassigning a vehicle with stock is a handover both sellers confirm; nothing moves.
    await admin.goto(`/console/vehicles/${vehicleId}`);
    await admin.getByLabel(m.vehicles.reassignTo).selectOption(sellerB.id);
    await admin.getByRole('button', { name: m.vehicles.reassign, exact: true }).click();
    await expect(admin.getByTestId('pending-handover')).toBeVisible();
    await sellerB.page.goto('/field/vehicle');
    await sellerB.page.getByTestId('handover').getByRole('button', { name: m.field.confirmHandover }).click();
    await expect(sellerB.page.getByTestId('handover')).toContainText(m.field.handoverWaitingOther);
    await phoneA.goto('/field/vehicle');
    await phoneA.getByTestId('handover').getByRole('button', { name: m.field.confirmHandover }).click();
    await expect(phoneA.getByTestId('handover')).toHaveCount(0);
    await admin.reload();
    await expect(admin.getByTestId('pending-handover')).toHaveCount(0);
    await expect(admin.getByRole('row').filter({ hasText: sellerB.name })).toContainText(m.vehicles.current);
    await expect(admin.getByRole('row').filter({ hasText: sellerA.name })).not.toContainText(m.vehicles.current);
    await sellerB.page.goto('/field/vehicle');
    await expect(sellerB.page.getByTestId(`batch-${early}`)).toBeVisible();
    expect(await batchPositions(admin, skuId, early)).toEqual({ warehouse: 6, vehicles: 4, total: 10 });
  });
}
