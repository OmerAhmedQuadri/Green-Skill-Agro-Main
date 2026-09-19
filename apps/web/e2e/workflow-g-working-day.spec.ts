import { expect, test, type Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aVehicle, batchOf, batchPositions, freshSeller, post, receiveStock, sessionPage, takePhoto } from './helpers';

type M = typeof en;
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);
const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });

/** Workflow G steps 1 and 7: the capture form, from the Today screen. */
async function capture(phone: Page, m: M, mode: 'in' | 'out', opts: { odometer?: string; withoutVehicle?: boolean } = {}) {
  await phone.goto('/field/today');
  const label = mode === 'in' ? m.field.checkIn : m.field.checkOut;
  const start = phone.getByTestId('day-card').getByRole('button', { name: new RegExp(`^${mode === 'in' ? `(${m.field.checkIn}|${m.field.checkInAgain})` : m.field.checkOut}$`) });
  await start.click();
  const form = phone.getByRole('form', { name: label });
  await expect(form.getByTestId('location')).not.toContainText(m.field.locating, { timeout: 20_000 });
  if (opts.withoutVehicle) await form.getByRole('checkbox').check();
  const selfie = await takePhoto(phone, `${mode}-selfie`, m);
  // NFR-009: what was uploaded is the compressed JPEG, measured before the form closes.
  const photo = Object.fromEntries(await Promise.all(['data-width', 'data-height', 'data-bytes'].map(async (a) => [a, Number(await selfie.getAttribute(a))] as const)));
  if (opts.odometer !== undefined) {
    await takePhoto(phone, `${mode}-odometer`, m);
    await form.getByLabel(m.field.odometerReading).fill(opts.odometer);
  } else {
    await expect(form.getByText(m.field.noOdometer)).toBeVisible();
  }
  await form.getByRole('button', { name: label, exact: true }).click();
  await expect(phone.getByTestId('day-card')).toBeVisible();
  return photo;
}

/**
 * Workflow G — the seller's working day (WORKFLOWS.md), in English and
 * Arabic, on a phone-sized screen with a camera and GPS: check in, the home
 * screen, breaks, the closing count, check out, a split shift, a doubtful
 * odometer, and a day without the vehicle.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Workflow G (${locale}) — ATT-001..012, STK-010, 011, EXP-007, WRO-001, NFR-003, NFR-004: a seller's working day on the phone`, async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const lot = `G-${locale}-${stamp}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'attendance.break_logging', enabled: true }, { key: 'attendance.restricted_check_in', enabled: false }] } });
    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 8, lot });
    const seller = await freshSeller(browser, admin, origin, locale, `G Seller ${locale} ${stamp}`);
    const vehicle = await aVehicle(admin, origin, 5000);
    await post(admin, origin, `/vehicles/${vehicle.id}/assign`, { sellerId: seller.id });
    const phone = seller.page;

    // ATT-010: with no open check-in, stock actions are refused.
    const early = await phone.request.post('/api/v1/closing-stock-declarations', { headers: headers(origin), data: { lines: [] } });
    expect(early.status()).toBe(409);
    expect(((await early.json()) as { code: string }).code).toBe('CHECK_IN_REQUIRED');

    // ATT-001: selfie from the live camera, location, odometer photo and reading.
    await phone.goto('/field/today');
    await expect(phone.getByTestId('day-card')).toContainText(m.field.status.NONE);
    const selfie = await capture(phone, m, 'in', { odometer: '5002' });
    await expect(phone.getByTestId('day-card')).toContainText(m.field.status.OPEN);
    await expect(phone.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    // NFR-009: the long edge of what was uploaded is at most 1600 px.
    expect(Math.max(selfie['data-width'] ?? 0, selfie['data-height'] ?? 0)).toBeLessThanOrEqual(1600);
    expect(selfie['data-bytes']).toBeGreaterThan(0);
    expect(selfie['data-bytes']).toBeLessThan(600_000);

    // A load arrives and the seller confirms it; one batch is to be sold first.
    const batchId = await batchOf(admin, skuId, lot);
    await admin.request.put(`/api/v1/batches/${batchId}/clearance-priority`, { headers: headers(origin), data: { prioritised: true, note: 'Sell first' } });
    await post(admin, origin, '/vehicle-loads', { vehicleId: vehicle.id, lines: [{ batchId, packs: 5 }], acknowledgeCeiling: true });
    await phone.goto('/field/vehicle');
    await phone.locator('[data-testid^="load-VL-"]').first().getByRole('button', { name: m.field.confirmLoad }).click();
    // EXP-007: an indicator on the affected item in the seller's own stock.
    await expect(phone.getByTestId(`batch-${lot}`).getByTestId('expiry-indicator')).toHaveText(m.field.indicator.prioritised);
    expect(await batchPositions(admin, skuId, lot)).toEqual({ warehouse: 3, vehicles: 5, total: 8 });

    // WRO-001: the seller writes off from the phone with a live-camera photo; the pack is held, not moved.
    await phone.getByTestId(`batch-${lot}`).getByRole('button', { name: m.field.writeOff }).click();
    await phone.getByLabel(fill(m.warehouse.packsToWriteOff, { held: 5 })).fill('1');
    await takePhoto(phone, `fw-photo-${batchId}`, m);
    await phone.getByRole('button', { name: m.warehouse.submitWriteOff }).click();
    await expect(phone.getByTestId(`batch-${lot}`)).toContainText(fill(m.field.heldPacks, { count: 1 }));
    expect(await batchPositions(admin, skuId, lot)).toEqual({ warehouse: 3, vehicles: 5, total: 8 });

    // EXP-007: home shows the vehicle's stock and flagged items.
    await phone.goto('/field/today');
    await expect(phone.getByTestId('vehicle-card')).toContainText(vehicle.registration);
    await expect(phone.getByTestId('flagged-items')).toBeVisible();

    // ATT-003: a break, where enabled, and back.
    await phone.getByRole('button', { name: m.field.startBreak }).click();
    await expect(phone.getByTestId('day-card')).toContainText(m.field.status.ON_BREAK);
    await phone.getByRole('button', { name: m.field.endBreak }).click();
    await expect(phone.getByTestId('day-card')).toContainText(m.field.status.OPEN);

    // STK-010, STK-011: closing stock is declared; a difference is flagged, not adjusted.
    await phone.getByRole('link', { name: m.field.declareClosing }).click();
    await phone.getByLabel(/OKRA-PK-5KG/).fill('4');
    await phone.getByRole('button', { name: m.field.declare }).click();
    await expect(phone.getByText(m.field.closingFlagged)).toBeVisible();
    expect(await batchPositions(admin, skuId, lot)).toEqual({ warehouse: 3, vehicles: 5, total: 8 });
    await admin.goto('/console/closing-stock');
    const declaration = admin.getByTestId(`closing-${seller.name}`);
    await expect(declaration).toContainText('OKRA-PK-5KG');
    await declaration.getByLabel(m.closing.comment).fill('One bag given as a sample');
    await declaration.getByRole('button', { name: m.closing.markReviewed }).click();
    await expect(declaration).toHaveCount(0); // gone from "difference to review"

    // ATT-002: check out — distance from the odometer and active hours.
    await capture(phone, m, 'out', { odometer: '5097' });
    await expect(phone.getByTestId('day-summary')).toContainText('95');

    // ATT-005: a second check-in the same day is a split shift, totalled as one day.
    await capture(phone, m, 'in', { odometer: '5097' });
    await capture(phone, m, 'out', { odometer: '5117' });
    await expect(phone.getByTestId('day-summary')).toContainText('115');

    // ATT-012: a reading below the vehicle's last is accepted and flagged for review.
    await capture(phone, m, 'in', { odometer: '4000' });
    await capture(phone, m, 'out', { odometer: '4001' });
    await expect(phone.getByTestId('day-summary')).toContainText(m.field.odometerFlagged);
    await admin.goto('/console/attendance');
    const day = admin.getByTestId(`day-${seller.name}`);
    await expect(day).toContainText(m.attendance.flags.BELOW_PREVIOUS);
    await expect(day.getByRole('link', { name: m.attendance.photos.checkInOdometer }).first()).toBeVisible();
    await day.getByRole('button', { name: m.attendance.review }).first().click();
    await day.getByLabel(m.attendance.reviewComment).fill('Typed 4000 for 5117 — photo shows 5117');
    await day.getByRole('button', { name: m.attendance.markReviewed }).click();
    await expect(day.getByRole('button', { name: m.attendance.review })).toHaveCount(0);

    // ATT-007: a collections day without the vehicle skips the odometer, records no distance, and has no vehicle stock.
    const collector = await freshSeller(browser, admin, origin, locale, `G Collector ${locale} ${stamp}`);
    await post(admin, origin, `/vehicles/${(await aVehicle(admin, origin, 7000)).id}/assign`, { sellerId: collector.id });
    await capture(collector.page, m, 'in', { withoutVehicle: true });
    await expect(collector.page.getByTestId('day-card')).toContainText(m.field.noVehicleToday);
    const refused = await collector.page.request.post('/api/v1/write-offs', { headers: headers(origin), data: { batchId, packs: 1, reason: 'DAMAGED', photoId: '00000000-0000-7000-8000-000000000000' } });
    expect(((await refused.json()) as { code: string }).code).toBe('NO_VEHICLE_TODAY');
    await capture(collector.page, m, 'out');
    await expect(collector.page.getByTestId('day-summary')).toContainText('—');
  });
}
