import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { post, sessionPage } from './helpers';

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);

/**
 * VEH-001, VEH-004, ATT-011, in English and Arabic — what happened on staging:
 * a correction typed with a thousands separator was saved as 0 km. Every
 * odometer the console takes reads grouped digits, in either script, and
 * refuses what it cannot read — never saving it as another figure, or dropping it.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  // As people type it: grouped by thousands — in Arabic, with Arabic digits and separator.
  const typed = (latin: string) => (locale === 'ar' ? latin.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d).replace(/,/g, '٬') : latin);
  test(`Odometer entry (${locale}) — VEH-001, VEH-004, ATT-011: grouped readings are read; one that cannot be read is refused, never saved as 0`, async ({ browser, baseURL }) => {
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    // The summary's odometer — the readings table heads a column with the same word.
    const odometerFact = admin.locator('dt', { hasText: m.vehicles.odometer }).locator('..');

    // Adding a vehicle: "45.2k" is refused; "45,210" is 45,210 km.
    await admin.goto('/console/vehicles');
    await admin.getByRole('button', { name: m.vehicles.add }).first().click();
    await admin.getByLabel(m.vehicles.registration).fill(`OD${locale.toUpperCase()} ${stamp}`);
    await admin.getByLabel(m.vehicles.odometerKm).fill('45.2k');
    await admin.getByRole('button', { name: m.vehicles.create }).click();
    await expect(admin.getByText(m.errors.INVALID_ODOMETER)).toBeVisible();
    await expect(admin).toHaveURL(/\/console\/vehicles$/);
    await admin.getByLabel(m.vehicles.odometerKm).fill(typed('45,210'));
    await admin.getByRole('button', { name: m.vehicles.create }).click();
    await admin.waitForURL(/\/console\/vehicles\/[0-9a-f-]{36}$/);
    const vehicleId = admin.url().split('/').at(-1) ?? '';
    await expect(odometerFact).toContainText(fill(m.vehicles.km, { km: '45,210' }));

    // Correcting it: "47,0x0" is refused and nothing is recorded; "47,050" with a note is a correction.
    const readings = async () => ((await (await admin.request.get(`/api/v1/vehicles/${vehicleId}`)).json()) as { readings: { readingKm: number; source: string }[] })
      .readings.map((r) => [r.readingKm, r.source]);
    await admin.getByRole('button', { name: m.common.edit, exact: true }).click();
    await admin.getByLabel(m.vehicles.correctOdometer).fill('47,0x0');
    await admin.getByLabel(m.vehicles.correctionNote).fill('Read again from the dashboard');
    await admin.getByRole('button', { name: m.common.save, exact: true }).click();
    await expect(admin.getByText(m.errors.INVALID_ODOMETER)).toBeVisible();
    expect(await readings()).toEqual([[45_210, 'REGISTRATION']]);
    await admin.getByLabel(m.vehicles.correctOdometer).fill(typed('47,050'));
    await admin.getByRole('button', { name: m.common.save, exact: true }).click();
    await expect(odometerFact).toContainText(fill(m.vehicles.km, { km: '47,050' }));
    expect(await readings()).toEqual([[47_050, 'CORRECTION'], [45_210, 'REGISTRATION']]);

    // Opening a day for a seller: a reading that cannot be read is refused, not dropped.
    const seller = (await post(admin, origin, '/users', {
      role: 'SELLER', name: `OD Seller ${locale} ${stamp}`, email: `od-seller-${locale}-${stamp}@e2e.local`, locale,
    })) as unknown as { account: { id: string } };
    await admin.goto('/console/attendance');
    await admin.getByRole('button', { name: m.attendance.openOnBehalf }).click();
    await admin.locator('#od-seller').selectOption(seller.account.id);
    await admin.locator('#od-reason').fill('Phone not charged');
    await admin.locator('#od-odometer').fill('12k');
    await admin.getByRole('button', { name: m.attendance.openDay, exact: true }).click();
    await expect(admin.getByText(m.errors.INVALID_ODOMETER)).toBeVisible();
    const days = (await (await admin.request.get(`/api/v1/attendance?sellerId=${seller.account.id}`)).json()) as unknown[];
    expect(days).toEqual([]);
  });
}
