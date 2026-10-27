import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aStoreByApi, freshSeller, PASSWORD, post, sessionPage, shot, signIn } from './helpers';

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
    const context = await browser.newContext({ baseURL: origin });
    const owner = await context.newPage();
    await signIn(owner, 'superadmin@dev.local');
    await context.addCookies([{ name: 'NEXT_LOCALE', value: locale, url: origin }]);
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
    const context = await browser.newContext({ baseURL: origin });
    const owner = await context.newPage();
    await signIn(owner, 'superadmin@dev.local');
    await context.addCookies([{ name: 'NEXT_LOCALE', value: locale, url: origin }]);
    const before = (await (await owner.request.get('/api/v1/corrections/status')).json()) as { mine: { id: string; version: number } | null };
    if (before.mine) await post(owner, origin, `/corrections/sessions/${before.mine.id}/close`, { version: before.mine.version, closing: 'KEPT' });

    // A store with a bill on its account.
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    const seller = await freshSeller(browser, admin, origin, locale, `COR Seller ${locale} ${stamp}`);
    const store = await aStoreByApi(seller.page, origin, `COR Store ${locale} ${stamp}`, { creditMode: 'WEEKLY', creditLimit: '5000.00' });
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
