import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { anImportedStore, aStoreByApi, aVehicle, batchOf, checkIn, freshSeller, PASSWORD, post, receiveStock, sessionPage, shot } from './helpers';

/** The text of a message before its first placeholder. */
const opening = (message: string) => message.slice(0, message.indexOf('{')).trim();

/**
 * ADR-0059, in English and Arabic: the Super Admin opens a correction session in Settings with their password and
 * a reason; Admins and Managers see that history is being corrected, and by whom; closing it edits the reason, and
 * the Corrections page shows the original struck through.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Correction sessions (${locale}) — COR-001, COR-003, COR-004: opened with a password, seen by others, closed with its reason`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const origin = baseURL ?? '';
    // Signed in once by the global setup: every sign-in here would count towards the run's limit (SECURITY §1).
    const owner = await sessionPage(browser, 'superadmin@dev.local', locale, origin);
    // A session left by an earlier, interrupted run would block opening another: close it first.
    const before = (await (await owner.request.get('/api/v1/corrections/status')).json()) as { mine: { id: string; version: number } | null };
    if (before.mine) await post(owner, origin, `/corrections/sessions/${before.mine.id}/close`, { version: before.mine.version, closing: 'KEPT' });

    // COR-001: off by default; opening takes the password and a reason.
    await owner.goto('/console/settings');
    const section = owner.getByTestId('corrections-settings');
    await expect(section).toContainText(m.corrections.settings.off);
    await section.getByRole('button', { name: m.corrections.settings.open, exact: true }).click();
    const reason = `e2e ${locale}: two vouchers of the October book carry the wrong store`;
    await section.locator('#correction-password').fill('not the password at all');
    await section.locator('#correction-reason').fill(reason);
    await section.getByRole('button', { name: m.corrections.settings.submit, exact: true }).click();
    await expect(section.getByRole('alert')).toContainText(m.errors.WRONG_PASSWORD);
    await section.locator('#correction-password').fill(PASSWORD);
    await section.getByRole('button', { name: m.corrections.settings.submit, exact: true }).click();
    await expect(section).toContainText(opening(m.corrections.settings.isOpen));
    // COR-004: the soft banner on the Super Admin's pages.
    const banner = owner.getByTestId('correction-banner-mine');
    await expect(banner).toContainText(reason);
    // The screen, not the whole page: Settings runs long, and the banner is at its top.
    await banner.scrollIntoViewIfNeeded();
    await owner.screenshot({ path: shot(`corrections-open-${locale}`) });

    // COR-004: Admins and Managers see that history is being corrected, and by whom; neither can open a session.
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    const manager = await sessionPage(browser, 'manager@dev.local', locale, origin);
    for (const page of [admin, manager]) {
      await page.goto('/console/dashboard');
      await expect(page.getByTestId('correction-banner-other')).toContainText('Dev Super Admin');
    }
    await admin.screenshot({ path: shot(`corrections-in-progress-${locale}`), fullPage: true });
    await admin.goto('/console/settings');
    await expect(admin.getByRole('heading', { name: m.settings.title, level: 1 })).toBeVisible();
    await expect(admin.getByTestId('corrections-settings')).toHaveCount(0);

    // COR-003: closed from the banner, with the reason edited.
    await banner.getByRole('button', { name: m.corrections.banner.close, exact: true }).click();
    const form = banner.getByTestId('correction-close');
    await expect(form).toContainText(reason);
    await form.getByLabel(m.corrections.close.EDITED, { exact: true }).check();
    const edited = `e2e ${locale}: three vouchers of the October book carry the wrong store`;
    await form.locator('textarea').fill(edited);
    await form.getByRole('button', { name: m.corrections.close.submit, exact: true }).click();
    await expect(owner.getByTestId('correction-banner-mine')).toHaveCount(0);
    await expect(section).toContainText(m.corrections.settings.off);

    // The Corrections page keeps the original reason, struck through, beside the edited one.
    await owner.getByRole('link', { name: m.nav.corrections, exact: true }).click();
    await expect(owner.getByRole('heading', { name: m.corrections.title, level: 1 })).toBeVisible();
    const row = owner.locator('[data-testid^="correction-session-"]').first();
    await expect(row.getByTestId('correction-reason-original')).toHaveText(reason);
    await expect(row).toContainText(edited);
    await expect(row).toContainText(m.corrections.list.states.CLOSED);
    await owner.screenshot({ path: shot(`corrections-page-${locale}`), fullPage: true });

    // Once closed, nobody sees it in progress.
    await admin.goto('/console/dashboard');
    await expect(admin.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(admin.getByTestId('correction-banner-other')).toHaveCount(0);
    // A Manager does not reach the Corrections page.
    expect((await manager.goto('/console/corrections'))?.status()).toBe(404);
  });
}

/**
 * COR-002, COR-005, in English and Arabic: in an open session the Super Admin corrects a bill on a store's page —
 * sees what it would change, confirms it with a reason — and the ledger keeps the original, struck through, beside
 * the corrected bill. The Corrections page lists the change.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Store-account corrections (${locale}) — COR-002, COR-005: a bill corrected from the store's page`, async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const owner = await sessionPage(browser, 'superadmin@dev.local', locale, origin);
    const before = (await (await owner.request.get('/api/v1/corrections/status')).json()) as { mine: { id: string; version: number } | null };
    if (before.mine) await post(owner, origin, `/corrections/sessions/${before.mine.id}/close`, { version: before.mine.version, closing: 'KEPT' });

    // A store with a bill on its account, onboarded by the Admin for a new seller who never signs in: each sign-in
    // counts towards the run's limit (SECURITY §1).
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    const seller = (await post(admin, origin, '/users', {
      role: 'SELLER', name: `COR Seller ${locale} ${stamp}`, email: `cor-seller-${locale}-${Date.now()}@e2e.local`, locale,
    })) as unknown as { account: { id: string } };
    const store = await aStoreByApi(admin, origin, `COR Store ${locale} ${stamp}`, { creditMode: 'WEEKLY', creditLimit: '5000.00' }, seller.account.id);
    // Store approval is an Admin switch; where it is off, the store is active already.
    if (store.status === 'PENDING_APPROVAL') await post(owner, origin, `/stores/${store.id}/approve`, { version: store.version });
    await post(owner, origin, `/stores/${store.id}/adjustments`, { amount: '300.00', reason: 'Opening balance', dueOn: '2026-09-01' });

    // Outside a session the page says how to start one, and offers no correction.
    await owner.goto(`/console/stores/${store.id}`);
    await expect(owner.getByText(m.corrections.entry.openSession)).toBeVisible();
    await expect(owner.getByRole('button', { name: m.corrections.entry.correct, exact: true })).toHaveCount(0);

    const opened = await owner.request.post('/api/v1/corrections/sessions', {
      headers: { origin }, data: { password: PASSWORD, reason: `e2e ${locale}: the opening balance of ${store.name as string} was 250` },
    });
    expect(opened.ok()).toBe(true);
    const session = (await opened.json()) as { id: string; version: number };
    await owner.reload();
    const bill = owner.getByTestId('ledger-ADJUSTMENT');
    await bill.getByRole('button', { name: m.corrections.entry.correct, exact: true }).click();
    const panel = owner.getByTestId('correct-entry');
    await panel.getByLabel(m.corrections.entry.amount, { exact: true }).fill('250');
    await panel.getByLabel(m.corrections.entry.reason, { exact: true }).fill(`e2e ${locale}: the opening balance was 250 on the September statement`);
    // COR-002: the effect first.
    await panel.getByRole('button', { name: m.corrections.entry.preview, exact: true }).click();
    const effect = panel.getByTestId(`correct-effect-${store.id}`);
    await expect(effect).toContainText('300.00');
    await expect(effect).toContainText('250.00');
    await owner.screenshot({ path: shot(`store-correction-effect-${locale}`), fullPage: true });
    await panel.getByRole('button', { name: m.corrections.entry.confirm, exact: true }).click();
    await expect(owner.getByTestId('correct-entry')).toHaveCount(0);
    await expect(owner.getByText(opening(m.corrections.entry.done))).toBeVisible();

    // The original stays, struck through; the corrected bill shows what it was.
    await expect(owner.getByTestId('ledger-replaced')).toBeVisible();
    await expect(owner.getByTestId('ledger-was')).toContainText('300.00');
    await expect(owner.getByTestId('total-outstanding')).toContainText('250.00');
    await owner.screenshot({ path: shot(`store-correction-ledger-${locale}`), fullPage: true });

    await owner.goto('/console/corrections');
    const change = owner.locator('[data-testid^="store-correction-"]').first();
    await expect(change).toContainText(store.name as string);
    await expect(change).toContainText('250.00');
    await expect(change).toContainText(`e2e ${locale}: the opening balance was 250`);

    await post(owner, origin, `/corrections/sessions/${session.id}/close`, { version: session.version, closing: 'KEPT' });
  });
}

const headers = (origin: string) => ({ origin, 'idempotency-key': crypto.randomUUID() });

/**
 * COR-006, COR-002, in English and Arabic: in an open session the Super Admin corrects a sale made in the app on its
 * page — fewer packs, the stock back on the vehicle, the bill and delivery document following — after seeing the
 * effect; the sale shows its correction. Then an imported invoice's lines, on its store's page, before the store is
 * re-verified. The Corrections page lists both.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Sale corrections (${locale}) — COR-006, COR-002: an app sale and an imported invoice corrected`, async ({ browser, baseURL }) => {
    test.setTimeout(360_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const lot = `COR-${locale}-${stamp}`;
    const owner = await sessionPage(browser, 'superadmin@dev.local', locale, origin);
    const before = (await (await owner.request.get('/api/v1/corrections/status')).json()) as { mine: { id: string; version: number } | null };
    if (before.mine) await post(owner, origin, `/corrections/sessions/${before.mine.id}/close`, { version: before.mine.version, closing: 'KEPT' });

    // A seller at work with six bags on the vehicle sells three to a store, at 90.00.
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.request.patch('/api/v1/feature-toggles', { headers: headers(origin), data: { changes: [{ key: 'stores.approval_required', enabled: false }, { key: 'attendance.restricted_check_in', enabled: false }] } });
    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 10, lot });
    const seller = await freshSeller(browser, admin, origin, locale, `COR Sale Seller ${locale} ${stamp}`);
    const phone = seller.page;
    const vehicle = await aVehicle(admin, origin, 10_000);
    await post(admin, origin, `/vehicles/${vehicle.id}/assign`, { sellerId: seller.id });
    await checkIn(phone, m, { odometer: '10002' });
    const batchId = await batchOf(admin, skuId, lot);
    const load = await post(admin, origin, '/vehicle-loads', { vehicleId: vehicle.id, lines: [{ batchId, packs: 6 }], acknowledgeCeiling: true });
    await post(phone, origin, `/vehicle-loads/${load.id}/confirm`, { version: load.version });
    const store = await aStoreByApi(phone, origin, `COR Sale Store ${locale} ${stamp}`, { creditMode: 'WEEKLY', creditLimit: '5000.00' });
    const sale = await post(phone, origin, '/sales', { storeId: store.id, lines: [{ skuId, packs: 3 }] });

    // Outside a session the sale says how to start one.
    await owner.goto(`/console/sales/${sale.id}`);
    await expect(owner.getByText(m.corrections.sale.openSession)).toBeVisible();
    const opened = await owner.request.post('/api/v1/corrections/sessions', {
      headers: { origin }, data: { password: PASSWORD, reason: `e2e ${locale}: October's sales that were written wrong` },
    });
    expect(opened.ok()).toBe(true);
    const session = (await opened.json()) as { id: string; version: number };
    // The delivery document is printed before its corrected copy can be issued.
    await expect(async () => {
      const doc = (await (await owner.request.get(`/api/v1/sales/${sale.id}`)).json()) as { document: { status: string } | null };
      expect(doc.document?.status).toBe('READY');
    }).toPass({ timeout: 60_000 });

    await owner.reload();
    await owner.getByRole('button', { name: m.corrections.sale.correct, exact: true }).click();
    const panel = owner.getByTestId('correct-sale');
    await panel.getByTestId('correct-packs-OKRA-PK-5KG').fill('2');
    await panel.getByTestId('follows-stock').check();
    await panel.getByLabel(m.corrections.sale.reason, { exact: true }).fill(`e2e ${locale}: the store took two bags, not three`);
    // COR-002: the effect first — the total, a bag back on the vehicle, the next copy of the document, the store's debt.
    await panel.getByRole('button', { name: m.corrections.sale.preview, exact: true }).click();
    await expect(panel.getByTestId('correct-sale-total')).toContainText('270.00');
    await expect(panel.getByTestId('correct-sale-total')).toContainText('180.00');
    await expect(panel.getByTestId('correct-sale-stock')).toContainText(vehicle.registration);
    await expect(panel.getByTestId(`correct-sale-store-${store.id}`)).toContainText('180.00');
    await owner.screenshot({ path: shot(`sale-correction-effect-${locale}`), fullPage: true });
    await panel.getByRole('button', { name: m.corrections.sale.confirm, exact: true }).click();
    await expect(owner.getByTestId('correct-sale')).toHaveCount(0);
    await expect(owner.getByText(opening(m.corrections.sale.done))).toBeVisible();
    const history = owner.getByTestId('sale-corrections');
    await expect(history).toContainText(`e2e ${locale}: the store took two bags, not three`);
    await expect(history).toContainText(m.corrections.sale.applied.stock);
    await expect(owner.getByTestId('document-version')).toContainText('2');
    await owner.screenshot({ path: shot(`sale-corrected-${locale}`), fullPage: true });

    // The seller sees the sale as corrected, and that the office corrected it.
    await phone.goto(`/field/sales/${sale.id}`);
    await expect(phone.getByTestId('sale-corrected')).toBeVisible();

    // An imported invoice, before its store is re-verified: its lines corrected on the store's page.
    const { storeId } = anImportedStore(seller.email, `COR Imported ${locale} ${stamp}`);
    await owner.goto(`/console/stores/${storeId}`);
    const invoice = owner.getByTestId('imported-invoice-501');
    await expect(invoice.getByTestId('imported-invoice-total')).toContainText('500.00');
    await invoice.getByRole('button', { name: m.corrections.imported.correct, exact: true }).click();
    const form = invoice.getByTestId('correct-invoice');
    await form.getByTestId('invoice-packs-0').fill('8');
    await form.getByLabel(m.corrections.imported.reason, { exact: true }).fill(`e2e ${locale}: eight bags, per the store's copy`);
    await form.getByRole('button', { name: m.corrections.imported.preview, exact: true }).click();
    await expect(form.getByTestId('correct-invoice-effect')).toContainText(m.corrections.imported.notPostedEffect);
    await form.getByRole('button', { name: m.corrections.imported.confirm, exact: true }).click();
    await expect(owner.getByTestId('imported-invoice-501').getByTestId('imported-invoice-total')).toContainText('400.00');
    await owner.screenshot({ path: shot(`imported-invoice-corrected-${locale}`), fullPage: true });

    // The Corrections page lists both.
    await owner.goto('/console/corrections');
    const changes = owner.locator('[data-testid^="sale-correction-"]');
    await expect(changes.first()).toContainText(`e2e ${locale}: eight bags`);
    await expect(changes.nth(1)).toContainText(`e2e ${locale}: the store took two bags`);

    await post(owner, origin, `/corrections/sessions/${session.id}/close`, { version: session.version, closing: 'KEPT' });
  });
}

