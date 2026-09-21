import { expect, test, type Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aStoreByApi, aVehicle, batchOf, checkIn, freshSeller, positionsOf, post, receiveStock, sessionPage } from './helpers';

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);

const owed = async (page: Page, storeId: string) =>
  ((await (await page.request.get(`/api/v1/stores/${storeId}`)).json()) as { credit: { outstanding: string } }).credit.outstanding;
/** Money renders with its currency, and Arabic wraps it in direction marks: match the amount inside. */
const money = (value: string) => new RegExp(`(^|[\\s\\u200e\\u200f])${value.replace('.', '\\.')}([\\s\\u200e\\u200f]|$)`);
const cashInHand = async (page: Page) => ((await (await page.request.get('/api/v1/cash/me')).json()) as { cashInHand: string }).cashInHand;

/**
 * Workflow L — a return or a replacement (WORKFLOWS.md), in English and
 * Arabic: from the sale it came from, the seller sends a bag back onto the
 * vehicle and the store owes less; a bag that cannot be sold again is written
 * off; a defective bag is swapped like for like from the vehicle with no money
 * moving; a defective bag the store had paid for is credited and the cash
 * handed back. The Admin switches a condition off, and a manager records a
 * credit note in the console with the goods going to a warehouse.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  const n = (v: string) => (locale === 'ar' ? v.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d) : v);
  test(`Workflow L (${locale}) — RET-001..012, WRO-007: goods back from a sale — credit, write-off, replacement, cash back`, async ({ browser, baseURL }) => {
    test.setTimeout(360_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const lot = `L-${locale}-${stamp}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: false }, { key: 'attendance.restricted_check_in', enabled: false }] } });
    await admin.request.patch('/api/v1/settings', { headers: headers(origin), data: { changes: [
      { key: 'returns.uncleared_payment_allowed', value: true }, { key: 'returns.uncleared_payment_window_days', value: 30 },
      { key: 'returns.defective_allowed', value: true }, { key: 'returns.defective_window_days', value: 30 },
    ] } });
    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 12, lot });

    const seller = await freshSeller(browser, admin, origin, locale, `L Seller ${locale} ${stamp}`);
    const phone = seller.page;
    const vehicle = await aVehicle(admin, origin, 10_000);
    await post(admin, origin, `/vehicles/${vehicle.id}/assign`, { sellerId: seller.id });
    await checkIn(phone, m, { odometer: '10002' });
    const load = await post(admin, origin, '/vehicle-loads', { vehicleId: vehicle.id, lines: [{ batchId: await batchOf(admin, skuId, lot), packs: 12 }], acknowledgeCeiling: true });
    await post(phone, origin, `/vehicle-loads/${load.id}/confirm`, { version: load.version });

    const credit = await aStoreByApi(phone, origin, `L Weekly ${locale} ${stamp}`, { creditMode: 'WEEKLY', creditLimit: '5000.00' });
    const cash = await aStoreByApi(phone, origin, `L Cash ${locale} ${stamp}`, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    const onCredit = await post(phone, origin, '/sales', { storeId: credit.id, lines: [{ skuId, packs: 4 }] });
    expect(await owed(phone, credit.id)).toBe('360.00');

    // RET-001, RET-002, RET-005: from the sale — what the store holds, what is unpaid, and the window.
    const onVehicle = async () => (await positionsOf(admin, skuId)).vehicles;
    const afterSale = await onVehicle();
    await phone.goto(`/field/sales/${onCredit.id}`);
    await phone.getByTestId('start-return').click();
    await expect(phone.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(phone.getByTestId('unpaid')).toHaveText(money('360.00'));
    await expect(phone.getByTestId('condition-UNCLEARED_PAYMENT')).toContainText(m.returns.conditions.UNCLEARED_PAYMENT);
    await expect(phone.getByTestId('condition-DEFECTIVE')).toContainText(m.returns.conditions.DEFECTIVE);

    // RET-007, RET-008: one bag back on its own batch; the store owes 90.00 less and nothing is refunded.
    const packsBack = (page: Page) => page.getByLabel(fill(m.returns.packsFor, { code: 'OKRA-PK-5KG', lot }));
    await packsBack(phone).fill(n('1'));
    await expect(phone.getByTestId('credit-amount')).toHaveText(money('90.00'));
    await expect(phone.getByTestId('refund')).toHaveText(money('0.00'));
    await phone.getByRole('button', { name: m.returns.recordCredit }).click();
    await phone.waitForURL(/\/field\/returns\/[0-9a-f-]{36}$/);
    await expect(phone.getByTestId('return-number')).toHaveText(/^CN-\d{4}-\d{6}$/);
    await expect(phone.getByTestId('returned-OKRA-PK-5KG')).toContainText(m.returns.outcomes.RESTOCK);
    expect(await onVehicle()).toBe(afterSale + 1);
    expect(await owed(phone, credit.id)).toBe('270.00');

    // RET-007: a bag that cannot be sold again is written off, not restocked.
    await phone.goto(`/field/sales/${onCredit.id}`);
    await phone.getByTestId('start-return').click();
    await packsBack(phone).fill(n('1'));
    await phone.getByLabel(fill(m.returns.unsaleableFor, { code: 'OKRA-PK-5KG', lot })).check();
    await phone.getByRole('button', { name: m.returns.recordCredit }).click();
    await phone.waitForURL(/\/field\/returns\/[0-9a-f-]{36}$/);
    await expect(phone.getByTestId('returned-OKRA-PK-5KG')).toContainText(m.returns.outcomes.WRITE_OFF);
    expect(await onVehicle()).toBe(afterSale + 1);
    expect(await owed(phone, credit.id)).toBe('180.00');

    // RET-010, RET-011, RET-012, WRO-007: defective, swapped like for like — stock moves, money does not.
    await phone.goto(`/field/sales/${onCredit.id}`);
    await phone.getByTestId('start-return').click();
    await phone.getByTestId('condition-DEFECTIVE').getByRole('radio').check();
    await phone.getByLabel(m.returns.outcome).selectOption('REPLACEMENT');
    await packsBack(phone).fill(n('1'));
    await phone.getByRole('button', { name: m.returns.recordReplacement }).click();
    await phone.waitForURL(/\/field\/returns\/[0-9a-f-]{36}$/);
    await expect(phone.getByTestId('return-number')).toHaveText(/^RP-\d{4}-\d{6}$/);
    await expect(phone.getByTestId('return-kind')).toHaveText(m.returns.kinds.REPLACEMENT);
    expect(await onVehicle()).toBe(afterSale); // one handed over, the defective one written off
    expect(await owed(phone, credit.id)).toBe('180.00');

    // RET-003, RET-008, OQ-020: paid for in cash, defective — the credit comes back as cash from the seller.
    const paid = await post(phone, origin, '/sales', { storeId: cash.id, lines: [{ skuId, packs: 2 }], payment: { method: 'CASH' } });
    expect(await cashInHand(phone)).toBe('180.00');
    await phone.goto(`/field/sales/${paid.id}`);
    await phone.getByTestId('start-return').click();
    await expect(phone.getByTestId('condition-UNCLEARED_PAYMENT')).toContainText(m.returns.blocked.SALE_ALREADY_PAID);
    await packsBack(phone).fill(n('1'));
    await expect(phone.getByTestId('refund')).toHaveText(money('90.00'));
    await phone.getByRole('button', { name: m.returns.recordCredit }).click();
    await phone.waitForURL(/\/field\/returns\/[0-9a-f-]{36}$/);
    await expect(phone.getByTestId('credit-split')).toContainText(m.returns.refund);
    expect(await cashInHand(phone)).toBe('90.00');
    expect(await owed(phone, cash.id)).toBe('0.00');

    // RET-009: the seller's month — sold, returned, and the net figure targets will use (M11).
    await phone.goto('/field/sales');
    await expect(phone.getByTestId('month-sold')).toContainText('540.00');
    await expect(phone.getByTestId('month-returned')).toContainText('270.00');
    await expect(phone.getByTestId('month-net')).toContainText('270.00');

    // RET-004: the Admin switches "not paid for yet" off — it cannot be used, and says so.
    await admin.request.patch('/api/v1/settings', { headers: headers(origin), data: { changes: [{ key: 'returns.uncleared_payment_allowed', value: false }] } });
    await admin.goto(`/console/sales/${onCredit.id}`);
    await admin.getByTestId('start-return').click();
    await expect(admin.getByTestId('condition-UNCLEARED_PAYMENT')).toContainText(m.returns.blocked.RETURN_CONDITION_DISABLED);
    await admin.request.patch('/api/v1/settings', { headers: headers(origin), data: { changes: [{ key: 'returns.uncleared_payment_allowed', value: true }] } });

    // Workflow L in the console: a manager records the credit note, the goods going back to a warehouse.
    const inWarehouse = async () => (await positionsOf(admin, skuId)).warehouse;
    const beforeWarehouse = await inWarehouse();
    await admin.reload();
    await packsBack(admin).fill('1');
    await expect(admin.getByLabel(m.returns.toWarehouse)).toBeVisible();
    await admin.getByRole('button', { name: m.returns.recordCredit }).click();
    await admin.waitForURL(/\/console\/returns\/[0-9a-f-]{36}$/);
    await expect(admin.getByTestId('returned-OKRA-PK-5KG')).toContainText(m.returns.outcomes.RESTOCK);
    expect(await inWarehouse()).toBe(beforeWarehouse + 1);
    expect(await owed(phone, credit.id)).toBe('90.00');
    // The seller sees it on their own sale.
    await phone.goto(`/field/sales/${onCredit.id}`);
    await expect(phone.getByTestId('sale-returns')).toContainText(m.returns.kinds.CREDIT_NOTE);

    // RET-008, CRD-003: and the store's ledger reads as a return rather than an
    // unexplained credit — the row links back to it, and the totals say what
    // was invoiced, paid and returned without adding up a year of lines.
    const returnId = /\/returns\/([0-9a-f-]{36})$/.exec(admin.url())?.[1];
    expect(returnId).toBeTruthy();
    await admin.goto(`/console/stores/${credit.id}`);
    // Newest first, so the first credit note is the one just recorded. This
    // store has taken several returns, which is why the totals are read for
    // what they are rather than pinned to one of them.
    await expect(admin.getByTestId('ledger-CREDIT_NOTE').first().getByRole('link'))
      .toHaveAttribute('href', `/console/returns/${returnId}`);
    await expect(admin.getByTestId('total-outstanding')).toHaveText(money('90.00'));
    await expect(admin.getByTestId('total-returned')).toBeVisible();
    await expect(admin.getByTestId('total-paid')).toBeVisible();
  });
}
