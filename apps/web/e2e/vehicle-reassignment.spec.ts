import { expect, test, type Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aVehicle, freshSeller, post, sessionPage, shot, takePhoto } from './helpers';

type M = typeof en;
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Check in from the Today screen — the first time or again — with the odometer when there is a vehicle (ATT-001). */
async function checkIn(phone: Page, m: M, odometer?: string) {
  await phone.goto('/field/today');
  await phone.getByTestId('day-card').getByRole('button', { name: new RegExp(`^(${m.field.checkIn}|${m.field.checkInAgain})$`) }).click();
  const form = phone.getByRole('form', { name: m.field.checkIn });
  await expect(form.getByTestId('location')).not.toContainText(m.field.locating, { timeout: 20_000 });
  await takePhoto(phone, 'in-selfie', m);
  if (odometer) {
    await takePhoto(phone, 'in-odometer', m);
    await form.getByLabel(m.field.odometerReading).fill(odometer);
  }
  await form.getByRole('button', { name: m.field.checkIn, exact: true }).click();
  await expect(phone.getByTestId('day-card')).toContainText(m.field.status.OPEN);
}

/**
 * ADR-0056, in English and Arabic — what Green Agro ran into: a vehicle
 * reassigned while its seller is out with it. The console asks whether it is
 * back; no changes nothing; yes, with the reading now, ends the seller's trip
 * and the vehicle passes. A seller given a vehicle while out is told to check
 * in again with it, and the next check-in works with the new vehicle.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  // An Arabic keyboard types Arabic-Indic digits; the app must read them (ADR-0026).
  const n = (v: string) => (locale === 'ar' ? v.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d) : v);
  test(`Vehicle reassignment (${locale}) — VEH-016, ATT-014: asked whether the vehicle is back, the trip ended at the manager's reading, the next trip with the new vehicle`, async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    const driver = await freshSeller(browser, admin, origin, locale, `R Driver ${locale} ${stamp}`);
    const taker = await freshSeller(browser, admin, origin, locale, `R Taker ${locale} ${stamp}`);
    const first = await aVehicle(admin, origin, 30_000);
    await post(admin, origin, `/vehicles/${first.id}/assign`, { sellerId: driver.id });

    // The driver goes out with it; the taker is checked in on foot, without a vehicle.
    await checkIn(driver.page, m, n('30004'));
    await checkIn(taker.page, m);

    // The vehicle page says who is out with it.
    await admin.goto(`/console/vehicles/${first.id}`);
    await expect(admin.getByTestId('vehicle-out')).toContainText(driver.name);

    // Reassigning asks whether it is back. No: nothing changes.
    const reassign = async () => {
      await admin.getByLabel(m.vehicles.reassignTo).selectOption(taker.id);
      await admin.getByRole('button', { name: m.vehicles.reassign, exact: true }).click();
    };
    await reassign();
    const question = admin.getByTestId('vehicle-back');
    await expect(question).toContainText(fill(m.vehicles.backTitle, { registration: first.registration }));
    await admin.screenshot({ path: shot(`vehicle-back-question-${locale}`), fullPage: true });
    await question.getByRole('button', { name: fill(m.vehicles.backNo, { name: driver.name }) }).click();
    await expect(question).toHaveCount(0);
    await expect(admin.getByRole('row').filter({ hasText: driver.name })).toContainText(m.vehicles.current);

    // Yes, with the reading now: the driver's trip ends there and the vehicle passes.
    await reassign();
    await question.getByLabel(m.vehicles.odometerKm).fill(n('30051'));
    await question.getByRole('button', { name: new RegExp(`^${escape(m.vehicles.backYes.split(' — ')[0] ?? '')}`) }).click();
    await expect(admin.getByTestId('trip-ended')).toContainText(driver.name);
    await expect(admin.getByText(m.vehicles.assigned)).toBeVisible();
    await expect(admin.getByRole('row').filter({ hasText: taker.name })).toContainText(m.vehicles.current);
    await expect(admin.getByRole('row').filter({ hasText: m.vehicles.sources.CHECK_OUT }).first()).toBeVisible();
    await expect(admin.getByTestId('vehicle-out')).toHaveCount(0);
    await admin.screenshot({ path: shot(`vehicle-back-done-${locale}`), fullPage: true });

    // The driver's phone: checked out, and told why.
    await driver.page.goto('/field/today');
    await expect(driver.page.getByTestId('day-card')).toContainText(m.field.status.CHECKED_OUT);
    await expect(async () => {
      await driver.page.reload();
      await driver.page.locator('[data-testid="notification-bell"]:visible').first().click();
      await expect(driver.page.getByTestId('notification-panel')).toContainText(first.registration, { timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await expect(driver.page.getByTestId('notification-panel')).toContainText(m.notifications.kinds.TRIP_CLOSED_ON_BEHALF.split(' {')[0] ?? '');
    await driver.page.screenshot({ path: shot(`vehicle-trip-ended-phone-${locale}`), fullPage: true });

    // The taker, out on foot when the vehicle became theirs, is told to check in again with it.
    await taker.page.goto('/field/today');
    await expect(taker.page.getByTestId('vehicle-changed')).toContainText(first.registration);
    await taker.page.screenshot({ path: shot(`vehicle-changed-phone-${locale}`), fullPage: true });

    // ATT-014: the driver, given another vehicle the same day, works with it from the next check-in.
    const second = await aVehicle(admin, origin, 40_000);
    await post(admin, origin, `/vehicles/${second.id}/assign`, { sellerId: driver.id });
    await checkIn(driver.page, m, n('40002'));
    await expect(driver.page.getByTestId('day-card')).toContainText(fill(m.field.withVehicle, { registration: second.registration }));
    await expect(driver.page.getByTestId('vehicle-changed')).toHaveCount(0);
    await driver.page.screenshot({ path: shot(`vehicle-new-trip-phone-${locale}`), fullPage: true });

    // Attendance: the trip a manager ended, and each trip's vehicle.
    await admin.goto('/console/attendance');
    const day = admin.getByTestId(`day-${driver.name}`);
    await expect(day.getByTestId('closed-on-behalf')).toHaveText(m.attendance.closedOnBehalf);
    await expect(day).toContainText(first.registration);
    await expect(day).toContainText(second.registration);
  });
}
