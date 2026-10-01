import { expect, test, type Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aStoreByApi, aVehicle, batchOf, checkIn, freshSeller, paidWith, post, receiveStock, sessionPage, shot } from './helpers';

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });
// The Riyadh month, not UTC's — as in targets.spec.ts. Saudi Arabia keeps UTC+3 all year.
const month = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 7);
/** A money figure as a whole number: "0.00" must not pass on "90.00". */
const amount = (value: string) => new RegExp(`(^|[^\\d.,])${value.replace('.', '\\.')}(?!\\d)`);

type Awaiting = { items: { id: string; number: string; decidable: boolean }[] };

/**
 * The console lists the oldest transfers awaiting confirmation, and a local
 * database keeps every earlier run's. Confirm those first — as an approver
 * working oldest first would — so this run's are on the screen.
 */
async function clearEarlierTransfers(admin: Page, origin: string, keep: readonly string[]) {
  for (;;) {
    const listed = (await (await admin.request.get('/api/v1/cash/transfers?limit=100')).json()) as Awaiting;
    const earlier = listed.items.filter((t) => t.decidable && !keep.includes(t.number));
    if (earlier.length === 0) return;
    for (const t of earlier) await post(admin, origin, `/cash/transfers/${t.id}/decide`, { outcome: 'CONFIRMED' });
  }
}

/**
 * A store's bank transfer earns commission once an approver confirms it
 * arrived (ADR-0046), in English and Arabic: two bags paid by transfer, one
 * confirmed and one found never to have arrived — which the store then owes
 * again, with the reason on its ledger and word to the seller.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Bank transfers (${locale}) — ADR-0046, COM-001, CRD-005: confirmed, a transfer earns commission; not received, the store owes it again`, async ({ browser, baseURL }) => {
    test.setTimeout(480_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const lot = `BT-${locale}-${stamp}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: false }, { key: 'attendance.restricted_check_in', enabled: false }] } });

    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 10, lot });
    const seller = await freshSeller(browser, admin, origin, locale, `BT Seller ${locale} ${stamp}`);
    const phone = seller.page;
    const vehicle = await aVehicle(admin, origin, 10_000);
    await post(admin, origin, `/vehicles/${vehicle.id}/assign`, { sellerId: seller.id });
    await checkIn(phone, m, { odometer: '10002' });
    const batchId = await batchOf(admin, skuId, lot);
    const load = await post(admin, origin, '/vehicle-loads', { vehicleId: vehicle.id, lines: [{ batchId, packs: 4 }], acknowledgeCeiling: true });
    await post(phone, origin, `/vehicle-loads/${load.id}/confirm`, { version: load.version });

    // Two bags at 90.00, each paid by bank transfer at the counter.
    const store = await aStoreByApi(phone, origin, `BT Store ${locale} ${stamp}`, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    const paidBy = async (reference: string) => {
      const sale = (await post(phone, origin, '/sales', {
        storeId: store.id, lines: [{ skuId, packs: 1 }], payment: await paidWith(phone, origin, '90.00', 'BANK_TRANSFER', reference),
      })) as unknown as { payment: { number: string } };
      return sale.payment.number;
    };
    const arrives = await paidBy(`TRX-A-${stamp}`);
    const bounces = await paidBy(`TRX-B-${stamp}`);

    // The seller's month is met on revenue, so the higher rate applies (COM-002).
    const rate = await admin.request.put(`/api/v1/commission-rates/${seller.id}`, { headers: headers(origin), data: { rate: { onTarget: '5', belowTarget: '2' } } });
    expect(rate.status()).toBe(200);
    const target = await admin.request.put('/api/v1/targets', {
      headers: headers(origin), data: { sellerId: seller.id, period: month(), goals: { REVENUE: '100.00' }, note: null },
    });
    expect(target.status()).toBe(200);

    // Until someone has seen the money arrive, it earns nothing.
    await phone.goto('/field/performance');
    await expect(phone.getByTestId('performance-transfers-awaiting')).toHaveText(amount('180.00'));
    await expect(phone.getByTestId('performance-commission-base')).toHaveText(amount('0.00'));

    // The approver checks each against the bank statement.
    await clearEarlierTransfers(admin, origin, [arrives, bounces]);
    await admin.goto('/console/cash');
    await expect(admin.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(admin.getByRole('heading', { name: m.cash.transfersTitle })).toBeVisible();
    await expect(admin.getByTestId(`transfer-${arrives}`)).toContainText(`TRX-A-${stamp}`);
    await admin.screenshot({ path: shot(`transfers-${locale}`), fullPage: true });
    const confirmed = admin.getByTestId(`transfer-${arrives}`);
    await confirmed.getByRole('button', { name: m.cash.confirmArrived }).click();
    await expect(confirmed).toHaveCount(0);

    // Not received has to say why.
    const missing = admin.getByTestId(`transfer-${bounces}`);
    await missing.getByRole('button', { name: m.cash.notReceived }).click();
    await expect(missing.getByRole('button', { name: m.cash.markNotReceived })).toBeDisabled();
    await missing.getByLabel(m.cash.notReceivedReason).fill('Not on the statement');
    await missing.getByRole('button', { name: m.cash.markNotReceived }).click();
    await expect(missing).toHaveCount(0);

    // COM-001: the confirmed transfer now earns — 5% of 90.00. The other never will.
    await phone.reload();
    await expect(phone.getByTestId('performance-transfers-awaiting')).toHaveText(amount('0.00'));
    await expect(phone.getByTestId('performance-commission-base')).toHaveText(amount('90.00'));
    await expect(phone.getByTestId('performance-commission')).toHaveText(amount('4.50'));

    // CRD-005: the store owes the one that never arrived, and its ledger says why…
    await admin.goto(`/console/stores/${store.id}`);
    await expect(admin.getByText(m.stores.transferNotReceived)).toBeVisible();
    await expect(admin.getByText('Not on the statement')).toBeVisible();
    // …and the seller is told, to chase it.
    const told = (await (await phone.request.get('/api/v1/notifications')).json()) as { items: { kind: string; params: Record<string, string> }[] };
    expect(told.items.find((n) => n.kind === 'TRANSFER_NOT_RECEIVED')?.params).toMatchObject({ number: bounces, reason: 'Not on the statement' });
  });
}
