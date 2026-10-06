import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { anUpload, sessionPage, shot, signIn } from './helpers';

/** The text of a message before its first placeholder — what a sentence with a date in it starts with. */
const opening = (message: string) => message.slice(0, message.indexOf('{')).trim();

/**
 * ADR-0049, in English and Arabic: an Admin keeps a file forever from its own
 * page and hands it back; the Super Admin sees what is stored and changes how
 * long a kind is kept — shown what the next clean-up would delete first.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Storage (${locale}) — SYS-010..013: what is stored, how long it is kept, and a file kept forever`, async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const origin = baseURL ?? '';

    // SYS-011: an Admin's write-off photo, kept forever from its page, then handed back to the policy.
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    const photoId = await anUpload(admin, origin, 'WRITE_OFF_EVIDENCE');
    await admin.goto(`/files/${photoId}`);
    const file = admin.getByTestId('file-page');
    await expect(file.getByRole('heading', { name: m.file.kinds.WRITE_OFF_EVIDENCE })).toBeVisible();
    await expect(file.getByRole('img', { name: m.file.kinds.WRITE_OFF_EVIDENCE })).toBeVisible();
    await expect(file.getByTestId('file-standing')).toContainText(opening(m.file.deletesOn));
    await file.getByRole('button', { name: m.file.keep, exact: true }).click();
    await expect(file.getByTestId('file-standing')).toContainText('Dev Admin');
    await admin.screenshot({ path: shot(`storage-file-kept-${locale}`), fullPage: true });
    await file.getByRole('button', { name: m.file.release, exact: true }).click();
    await expect(file.getByTestId('file-standing')).toContainText(opening(m.file.deletesOn));
    // The storage page is the Super Admin's alone.
    expect((await admin.goto('/console/storage'))?.status()).toBe(404);

    // SYS-013: the Super Admin's view.
    const context = await browser.newContext({ baseURL: origin });
    const owner = await context.newPage();
    await signIn(owner, 'superadmin@dev.local');
    // Signing in sets the account's own language; this run's goes on afterwards.
    await context.addCookies([{ name: 'NEXT_LOCALE', value: locale, url: origin }]);
    await owner.goto('/console/dashboard');
    await owner.getByRole('link', { name: m.nav.storage, exact: true }).click();
    await expect(owner.getByRole('heading', { name: m.storage.title, level: 1 })).toBeVisible();
    for (const id of ['storage-files', 'storage-database', 'storage-backups', 'storage-disk']) await expect(owner.getByTestId(id)).toBeVisible();
    await expect(owner.getByTestId('storage-row-WRITE_OFF_EVIDENCE')).toContainText(m.storage.kinds.WRITE_OFF_EVIDENCE);
    // The approved defaults; a selfie can never be kept forever as a kind.
    await expect(owner.getByTestId('storage-keep-STOREFRONT')).toHaveValue('FOREVER');
    await expect(owner.getByTestId('storage-keep-SELFIE').locator('option[value="FOREVER"]')).toHaveCount(0);
    await owner.screenshot({ path: shot(`storage-${locale}`), fullPage: true });

    // SYS-012: a shorter period first shows what the next clean-up would delete. Every file a run
    // makes is from today, so none is old enough to be due: the preview is made to report some.
    await owner.route('**/api/v1/storage/preview**', async (route) => {
      const real = await route.fetch();
      const body = (await real.json()) as { runAt: string; due: Record<string, { files: number; bytes: number }> };
      await route.fulfill({ response: real, json: { ...body, due: { ...body.due, TRANSPORT_SLIP: { files: 12, bytes: 3_400_000 } } } });
    });
    const saving = () => owner.waitForResponse((r) => r.url().endsWith('/api/v1/storage') && r.request().method() === 'PATCH');
    await owner.getByTestId('storage-keep-TRANSPORT_SLIP').selectOption('1');
    await owner.getByRole('button', { name: m.storage.save }).click();
    const confirm = owner.getByTestId('storage-confirm');
    await expect(confirm).toContainText(m.storage.confirmTitle);
    await owner.screenshot({ path: shot(`storage-confirm-${locale}`), fullPage: true });
    await confirm.getByRole('button', { name: m.common.cancel }).click();
    await expect(confirm).toHaveCount(0);
    await owner.getByRole('button', { name: m.storage.save }).click();
    const confirmed = saving();
    await owner.getByTestId('storage-confirm').getByRole('button', { name: m.storage.confirm }).click();
    expect((await confirmed).ok()).toBe(true);
    await expect(owner.getByText(m.common.saved)).toBeVisible();
    await owner.reload();
    await expect(owner.getByTestId('storage-keep-TRANSPORT_SLIP')).toHaveValue('1');

    // Back to the approved six months: a longer period deletes nothing more, so it saves without asking.
    await owner.unroute('**/api/v1/storage/preview**');
    await owner.getByTestId('storage-keep-TRANSPORT_SLIP').selectOption('6');
    const restored = saving();
    await owner.getByRole('button', { name: m.storage.save }).click();
    expect((await restored).ok()).toBe(true);
    await expect(owner.getByTestId('storage-confirm')).toHaveCount(0);
    await owner.reload();
    await expect(owner.getByTestId('storage-keep-TRANSPORT_SLIP')).toHaveValue('6');
    await context.close();
  });
}
