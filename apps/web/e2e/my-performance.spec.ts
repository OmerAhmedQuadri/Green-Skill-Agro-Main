import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aStoreByApi, aVehicle, anUpload, batchOf, checkIn, freshSeller, paidWith, post, receiveStock, sessionPage, shot } from './helpers';

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });
// Riyadh's date and month, not UTC's — as in targets.spec.ts. Saudi Arabia keeps UTC+3 all year.
const riyadhToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const month = () => riyadhToday().slice(0, 7);
const monthBefore = (value: string) => {
  const [year, m] = value.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, m - 2, 1)).toISOString().slice(0, 7);
};
/** A money figure as a whole number: "0.00" must not pass on "450.00" while the next month loads. */
const amount = (value: string) => new RegExp(`(^|[^\\d.,])${value.replace('.', '\\.')}(?!\\d)`);

/**
 * A seller's own month on one screen (RPT-010, RPT-008), in English and Arabic:
 * sales, what was collected by each method, cash in hand and handed over, and
 * the commission the Targets screen shows. Opened from Today; the month picker
 * changes the month, and "right now" stays right now.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`My performance (${locale}) — RPT-010, RPT-008, CSH-005, COM-001: a seller's month in one place`, async ({ browser, baseURL }) => {
    test.setTimeout(480_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const lot = `P-${locale}-${stamp}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: false }, { key: 'attendance.restricted_check_in', enabled: false }] } });

    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 10, lot });
    const seller = await freshSeller(browser, admin, origin, locale, `P Seller ${locale} ${stamp}`);
    const phone = seller.page;
    const vehicle = await aVehicle(admin, origin, 10_000);
    await post(admin, origin, `/vehicles/${vehicle.id}/assign`, { sellerId: seller.id });
    await checkIn(phone, m, { odometer: '10002' });
    const batchId = await batchOf(admin, skuId, lot);
    const load = await post(admin, origin, '/vehicle-loads', { vehicleId: vehicle.id, lines: [{ batchId, packs: 6 }], acknowledgeCeiling: true });
    await post(phone, origin, `/vehicle-loads/${load.id}/confirm`, { version: load.version });

    // Five bags at 90.00: three and then one paid in cash, one by bank transfer.
    const store = await aStoreByApi(phone, origin, `P Store ${locale} ${stamp}`, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    const sell = async (packs: number, method: 'CASH' | 'BANK_TRANSFER' = 'CASH', reference?: string) => post(phone, origin, '/sales', {
      storeId: store.id, lines: [{ skuId, packs }], payment: await paidWith(phone, origin, (packs * 90).toFixed(2), method, reference),
    });
    await sell(3);
    await sell(1, 'BANK_TRANSFER', `TRX-${stamp}`);
    await sell(1);

    // 270.00 of the cash banked and approved; the other 90.00 banked and waiting.
    const bank = async (value: string) => post(phone, origin, '/cash/settlements', {
      route: 'BANK_DEPOSIT', amount: value, depositedOn: riyadhToday(), photoId: await anUpload(phone, origin, 'DEPOSIT_SLIP'),
    });
    const approved = await bank('270.00');
    await post(admin, origin, `/cash/settlements/${approved.id}/decide`, { version: approved.version, approve: true });
    await bank('90.00');

    // The seller's month, met on both figures set, so the higher rate applies (COM-002).
    const rate = await admin.request.put(`/api/v1/commission-rates/${seller.id}`, {
      headers: headers(origin), data: { rate: { onTarget: '5', belowTarget: '2' } },
    });
    expect(rate.status()).toBe(200);
    const target = await admin.request.put('/api/v1/targets', {
      headers: headers(origin), data: { sellerId: seller.id, period: month(), goals: { REVENUE: '200.00', COLLECTED: '200.00' }, note: null },
    });
    expect(target.status()).toBe(200);

    // Opened from Today, the screen the seller starts their day on.
    await phone.goto('/field/today');
    await expect(phone.getByTestId('performance-card')).toBeVisible();
    await phone.getByTestId('to-performance').click();
    await expect(phone).toHaveURL(/\/field\/performance$/);
    await expect(phone.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(phone.getByRole('heading', { name: m.performance.title })).toBeVisible();
    await expect(phone.locator('#performance-month')).toHaveValue(month());

    // RPT-010: the month's sales…
    await expect(phone.getByTestId('performance-sold')).toHaveText(amount('450.00'));
    await expect(phone.getByTestId('performance-returned')).toHaveText(amount('0.00'));
    await expect(phone.getByTestId('performance-net')).toHaveText(amount('450.00'));
    // RPT-008: …what was collected from stores, by method…
    await expect(phone.getByTestId('performance-collected-cash')).toHaveText(amount('360.00'));
    await expect(phone.getByTestId('performance-collected-bank')).toHaveText(amount('90.00'));
    await expect(phone.getByTestId('performance-collected-total')).toHaveText(amount('450.00'));
    // CSH-005: …the cash handed over and approved, what is waiting, and what is still in hand
    // (360.00 of cash in, 270.00 approved out; the 90.00 waiting moves nothing until it is decided)…
    await expect(phone.getByTestId('performance-settled')).toHaveText(amount('270.00'));
    await expect(phone.getByTestId('performance-awaiting')).toHaveText(amount('90.00'));
    await expect(phone.getByTestId('performance-cash-in-hand')).toHaveText(amount('90.00'));
    // ADR-0046: the bank transfer earns nothing until an approver confirms it arrived.
    await expect(phone.getByTestId('performance-transfers-awaiting')).toHaveText(amount('90.00'));
    // COM-001: …and the Targets screen's commission — 5% of the 270.00 that reached the business.
    await expect(phone.getByTestId('performance-commission-base')).toHaveText(amount('270.00'));
    await expect(phone.getByTestId('performance-commission')).toHaveText(amount('13.50'));
    await expect(phone.getByTestId('performance-period-state')).toHaveText(m.targets.live);
    await phone.screenshot({ path: shot(`performance-${locale}`), fullPage: true });

    // RPT-010: an earlier month shows that month; "right now" does not move with it.
    await phone.locator('#performance-month').selectOption(monthBefore(month()));
    await expect(phone.getByTestId('performance-sold')).toHaveText(amount('0.00'));
    await expect(phone.getByTestId('performance-collected-total')).toHaveText(amount('0.00'));
    await expect(phone.getByTestId('performance-settled')).toHaveText(amount('0.00'));
    await expect(phone.getByTestId('performance-cash-in-hand')).toHaveText(amount('90.00'));
    await expect(phone.getByTestId('performance-awaiting')).toHaveText(amount('90.00'));

    // Nobody else has one: no figures from the API, and no page.
    expect((await admin.request.get('/api/v1/reports/my-performance')).status()).toBe(403);
    expect((await admin.goto('/field/performance'))?.status()).toBe(404);
  });
}
