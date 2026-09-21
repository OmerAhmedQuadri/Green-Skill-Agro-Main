import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aStoreByApi, aVehicle, anUpload, batchOf, checkIn, freshSeller, post, receiveStock, sessionPage } from './helpers';

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });
const month = () => new Date().toISOString().slice(0, 7);

/**
 * Targets and commission (TGT-001..005, COM-001..007, ADR-0042), in English and
 * Arabic: a manager sets a seller's month, the seller sees their own progress
 * and what they have earned on cash that reached the business, and sees nobody
 * else's. M11 has no lettered workflow of its own — workflow O is the import
 * order — so this covers the screens that milestone delivers.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  const n = (v: string) => (locale === 'ar' ? v.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d) : v);
  test(`Targets (${locale}) — TGT-001, TGT-004, COM-001, COM-002, COM-003, COM-004, COM-006, COM-007: a month set, progress shown, commission on settled cash`, async ({ browser, baseURL }) => {
    test.setTimeout(480_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const lot = `T-${locale}-${stamp}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: false }, { key: 'attendance.restricted_check_in', enabled: false }] } });

    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 10, lot });
    const seller = await freshSeller(browser, admin, origin, locale, `T Seller ${locale} ${stamp}`);
    const phone = seller.page;
    const vehicle = await aVehicle(admin, origin, 10_000);
    await post(admin, origin, `/vehicles/${vehicle.id}/assign`, { sellerId: seller.id });
    await checkIn(phone, m, { odometer: '10002' });
    const batchId = await batchOf(admin, skuId, lot);
    const load = await post(admin, origin, '/vehicle-loads', { vehicleId: vehicle.id, lines: [{ batchId, packs: 6 }], acknowledgeCeiling: true });
    await post(phone, origin, `/vehicle-loads/${load.id}/confirm`, { version: load.version });

    // Three bags at 90.00, paid in cash: 270.00 in the seller's hands.
    const store = await aStoreByApi(phone, origin, `T Store ${locale} ${stamp}`, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    await post(phone, origin, '/sales', { storeId: store.id, lines: [{ skuId, packs: 3 }], payment: { method: 'CASH' } });

    // COM-001: still in the seller's hands, so nothing has been earned on it yet.
    await phone.goto('/field/targets');
    await expect(phone.getByTestId('commission-base')).toContainText('0.00');

    // The manager sets the month (TGT-001..003).
    const rate = await admin.request.put(`/api/v1/commission-rates/${seller.id}`, {
      headers: headers(origin), data: { rate: { onTarget: '5', belowTarget: '2' } },
    });
    expect(rate.status()).toBe(200);
    const target = await admin.request.put('/api/v1/targets', {
      headers: headers(origin), data: { sellerId: seller.id, period: month(), goals: { REVENUE: '200.00', COLLECTED: '200.00' }, note: null },
    });
    expect(target.status()).toBe(200);

    // The cash reaches the business: declared, then approved (COM-001, OQ-023).
    const settlement = await post(phone, origin, '/cash/settlements', {
      route: 'BANK_DEPOSIT', amount: '270.00', depositedOn: '2026-09-20', photoId: await anUpload(phone, origin, 'DEPOSIT_SLIP'),
    });
    await post(admin, origin, `/cash/settlements/${settlement.id}/decide`, { version: settlement.version, approve: true });

    // TGT-004, COM-004: the seller's own month — every figure that was set, its
    // achievement, and the commission that follows.
    await phone.goto('/field/targets');
    await expect(phone.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(phone.getByTestId('my-metric-REVENUE')).toBeVisible();
    await expect(phone.getByTestId('my-metric-COLLECTED')).toBeVisible();
    // 270 against a 200 goal is 135%. ADR-0026: figures read the same in both languages.
    await expect(phone.getByTestId('achievement-REVENUE')).toContainText('135');
    await expect(phone.getByTestId('commission-base')).toContainText('270.00');
    // COM-002: the month was met, so the higher rate applies — 5% of 270.
    await expect(phone.getByTestId('commission-amount')).toContainText('13.50');
    await expect(phone.getByTestId('period-state')).toHaveText(m.targets.live);

    // COM-006: Phase 1 calculates and reports. There is nothing here that pays it.
    await expect(phone.getByRole('button', { name: m.common.save })).toHaveCount(0);

    // Workflows G and I, TGT-004, SAL-007: the same progress on the home screen
    // the seller actually starts their day on, moved by the sale they recorded.
    // Built in M11 and shown here ever since, but until now nothing checked it.
    await phone.goto('/field/today');
    await expect(phone.getByTestId('today-metric-REVENUE')).toBeVisible();
    await expect(phone.getByTestId('today-metric-COLLECTED')).toBeVisible();
    // The achievement carries the metric's own id, so it is found inside its row.
    await expect(phone.getByTestId('today-metric-REVENUE').getByTestId('achievement-REVENUE')).toContainText('135');
    await phone.getByTestId('to-targets').click();
    await expect(phone).toHaveURL(/\/field\/targets$/);

    // COM-007: the manager sees this seller among the others.
    await admin.goto('/console/targets');
    const row = admin.getByTestId(`standing-${seller.id}`);
    await expect(row).toBeVisible();
    await expect(admin.getByTestId(`base-${seller.id}`)).toContainText('270.00');
    await expect(admin.getByTestId(`commission-${seller.id}`)).toContainText('13.50');

    // TGT-001: and can change the month from here.
    await admin.getByTestId(`set-${seller.id}`).click();
    await admin.getByLabel(m.targets.metrics.REVENUE, { exact: true }).first().fill(n('50000'));
    await admin.getByRole('button', { name: m.targets.saveTarget }).click();
    // Missed now, so the lower rate applies: 2% of 270.
    await expect(admin.getByTestId(`commission-${seller.id}`)).toContainText('5.40');

    // COM-007: a seller sees their own figures and nobody else's.
    await phone.goto('/console/targets');
    await expect(phone.getByTestId(`standing-${seller.id}`)).toHaveCount(0);
  });
}
