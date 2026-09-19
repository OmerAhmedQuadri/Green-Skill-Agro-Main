import { expect, test, type Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aJpeg, aStoreByApi, aVehicle, batchOf, checkIn, freshSeller, post, receiveStock, sessionPage } from './helpers';

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });
/** Money renders with its currency, and Arabic wraps it in direction marks: match the amount inside. */
const money = (value: string) => new RegExp(`(^|[\\s\\u200e\\u200f])${value.replace('.', '\\.')}([\\s\\u200e\\u200f]|$)`);
const cashInHand = async (page: Page) => ((await (await page.request.get('/api/v1/cash/me')).json()) as { cashInHand: string }).cashInHand;

/**
 * Workflow M — settling cash (WORKFLOWS.md), in English and Arabic: the seller
 * banks what they collected, with the slip; nothing leaves their cash in hand
 * until a manager approves it; a manager who counts less keeps the difference
 * on record and the rest stays with the seller. A seller over the cash ceiling
 * is flagged on the dashboard and warned, and settling clears the flag.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  const n = (v: string) => (locale === 'ar' ? v.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d) : v);
  test(`Workflow M (${locale}) — CSH-002..007, LIM-002, LIM-004, LIM-005: cash banked, approved, and a ceiling breach`, async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const lot = `M-${locale}-${stamp}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: false }, { key: 'attendance.restricted_check_in', enabled: false }] } });
    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 6, lot });

    const seller = await freshSeller(browser, admin, origin, locale, `M Seller ${locale} ${stamp}`);
    const phone = seller.page;
    const vehicle = await aVehicle(admin, origin, 10_000);
    await post(admin, origin, `/vehicles/${vehicle.id}/assign`, { sellerId: seller.id });
    await checkIn(phone, m, { odometer: '10002' });
    const load = await post(admin, origin, '/vehicle-loads', { vehicleId: vehicle.id, lines: [{ batchId: await batchOf(admin, skuId, lot), packs: 6 }], acknowledgeCeiling: true });
    await post(phone, origin, `/vehicle-loads/${load.id}/confirm`, { version: load.version });

    // LIM-002, LIM-004: this seller may hold 200.00 in cash; a 450.00 sale takes them over it.
    await admin.request.put('/api/v1/ceilings', { headers: headers(origin), data: { kind: 'CASH_IN_HAND', sellerId: seller.id, amount: '200.00' } });
    const store = await aStoreByApi(phone, origin, `M Cash ${locale} ${stamp}`, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    await post(phone, origin, '/sales', { storeId: store.id, lines: [{ skuId, packs: 5 }], payment: { method: 'CASH' } });
    expect(await cashInHand(phone)).toBe('450.00');

    // LIM-004: the dashboard carries the breach; LIM-002: the seller is told.
    await admin.goto('/console/dashboard');
    // Other runs leave their own sellers over the limit, so look only at this one.
    const flag = admin.getByTestId('flag-CASH_IN_HAND').filter({ hasText: seller.name });
    await expect(flag).toHaveCount(1);
    const told = (await (await phone.request.get('/api/v1/notifications')).json()) as { items: { kind: string }[] };
    expect(told.items.map((x) => x.kind)).toContain('CEILING_BREACHED');

    // LIM-005: a warning only — the seller keeps working and sells again.
    await post(phone, origin, '/sales', { storeId: store.id, lines: [{ skuId, packs: 1 }], payment: { method: 'CASH' } });
    expect(await cashInHand(phone)).toBe('540.00');

    // CSH-002, CSH-005: the seller banks it with the slip; nothing moves yet.
    await phone.goto('/field/today');
    await phone.getByTestId('to-cash').click();
    await expect(phone.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(phone.getByTestId('cash-in-hand')).toHaveText(money('540.00'));
    await phone.getByLabel(m.cash.amount).fill(n('540.00'));
    await phone.locator('#slip-file').setInputFiles({ name: 'deposit.jpg', mimeType: 'image/jpeg', buffer: await aJpeg(phone) });
    await expect(phone.getByTestId('slip-ready')).toBeVisible({ timeout: 30_000 });
    await phone.getByRole('button', { name: m.cash.submit }).click();
    await phone.waitForURL(/\/field\/cash\/[0-9a-f-]{36}$/);
    const number = (await phone.getByRole('heading').first().textContent()) ?? '';
    expect(number).toMatch(/^ST-\d{4}-\d{6}$/);
    await expect(phone.getByTestId('settlement-status')).toHaveText(m.cash.statuses.SUBMITTED);
    expect(await cashInHand(phone)).toBe('540.00');

    // CSH-004, CSH-006: the manager counts 500.00 — the difference is kept and the rest stays with the seller.
    await admin.goto('/console/cash');
    await admin.getByTestId(`waiting-${number}`).getByRole('link').click();
    await admin.getByLabel(m.cash.counted).fill('500.00');
    await admin.getByLabel(m.cash.comment).fill('Counted 500 at the bank');
    await admin.getByRole('button', { name: m.cash.approve }).click();
    await expect(admin.getByTestId('settlement-status')).toHaveText(m.cash.statuses.APPROVED);
    await expect(admin.getByTestId('approved')).toHaveText(money('500.00'));
    await expect(admin.getByTestId('shortfall')).toHaveText(money('40.00'));
    expect(await cashInHand(phone)).toBe('40.00');

    // CSH-007: back under the ceiling, the flag is gone from the dashboard.
    await admin.goto('/console/dashboard');
    await expect(flag).toHaveCount(0);
    // The seller sees the decision on their own settlement.
    await phone.reload();
    await expect(phone.getByTestId('settlement-status')).toHaveText(m.cash.statuses.APPROVED);
    await expect(phone.getByTestId('shortfall')).toHaveText(money('40.00'));
  });
}
