import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { freshSeller, sessionPage, shot, takePhoto } from './helpers';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** A store imported from synthetic books for this seller (IMP-008): two invoices and a payment, 400.00 owing. */
function anImportedStore(sellerEmail: string, name: string): { storeId: string; balance: string } {
  const out = execFileSync('pnpm', ['--filter', '@gsa/services', 'run', '--silent', 'e2e-imported-store', sellerEmail, name], { cwd: ROOT, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { storeId: string; balance: string };
}

/**
 * IMP-005, IMP-008, IMP-003, in English and Arabic: a store imported from the books awaits re-verification. Its seller
 * opens it, fills in what the books lack, shows the owner what the books say and records that the store disputes it;
 * the imported bills and payment go into its account, labelled. The Super Admin keeps an import warning with a note.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Store re-verification (${locale}) — IMP-005, IMP-008, IMP-003, IMP-009: an imported store re-verified on the phone, disputed; a warning kept`, async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const origin = baseURL ?? '';
    const stamp = String(Date.now()).slice(-6);
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    const seller = await freshSeller(browser, admin, origin, locale, `G Seller ${locale} ${stamp}`);
    const phone = seller.page;
    const name = `Imported Seeds ${locale} ${stamp}`;
    const { storeId } = anImportedStore(seller.email, name);
    await phone.context().setGeolocation({ latitude: 18 + Math.random() * 10, longitude: 40 + Math.random() * 10, accuracy: 12 });

    // IMP-008: awaiting re-verification — it cannot be sold to, and says how to begin.
    await phone.goto(`/field/stores/${storeId}`);
    await expect(phone.getByTestId('credit-blocked')).toContainText(m.stores.reasons.NOT_VERIFIED);
    await phone.getByRole('link', { name: m.stores.reverifyAction }).click();
    await phone.waitForURL(`**/field/stores/${storeId}/reverify`);

    // What the books say, shown to the owner first.
    await expect(phone.getByTestId('imported-history')).toContainText('500.00');
    await expect(phone.getByTestId('imported-balance')).toContainText('400.00');
    await expect(phone.getByTestId('location')).not.toContainText(m.stores.locating, { timeout: 20_000 });
    await expect(phone.getByLabel(m.stores.name, { exact: true })).toHaveValue(name);
    await phone.getByLabel(m.stores.ownerName).fill('Saeed Al-Qahtani');
    await phone.getByLabel(m.stores.contactNumber).fill('0501234567');
    await takePhoto(phone, 'st-photo', m);
    await phone.getByLabel(m.stores.creditMode).selectOption('WEEKLY');
    await phone.getByLabel(m.stores.creditLimit).fill('1000');
    const confirmation = phone.getByTestId('balance-confirmation');
    await confirmation.getByLabel(m.stores.DISPUTED, { exact: true }).check();
    await confirmation.getByLabel(m.stores.disputeNote).fill(`e2e ${locale}: the owner says one more payment of 100 was made in October`);
    await phone.screenshot({ path: shot(`store-reverify-${locale}`), fullPage: true });
    await phone.getByRole('button', { name: m.stores.reverify, exact: true }).click();
    await phone.waitForURL(`**/field/stores/${storeId}`);

    // IMP-005, IMP-003: the books are in its account now, each entry saying where it was written.
    await expect(phone.getByTestId('ledger-imported')).toHaveCount(3);
    await expect(phone.getByTestId('ledger-imported').first()).toContainText(m.stores.importedBadge);
    await phone.screenshot({ path: shot(`store-reverified-${locale}`), fullPage: true });

    // The console shows the re-verification and the store's words.
    await admin.goto(`/console/stores/${storeId}`);
    await expect(admin.getByTestId('reverification')).toContainText(`e2e ${locale}: the owner says one more payment`);
    await expect(admin.getByTestId('ledger-imported')).toHaveCount(3);

    // IMP-009: what the import could not settle waits on the Super Admin's dashboard, and is kept with a note.
    const owner = await sessionPage(browser, 'superadmin@dev.local', locale, origin);
    await owner.goto('/console/dashboard');
    await owner.getByRole('link', { name: new RegExp(m.dashboard.waiting.queues.IMPORT_WARNINGS) }).click();
    await owner.waitForURL('**/console/corrections**');
    const warning = owner.getByTestId('import-warning-RETURN_NOT_IMPORTED').filter({ hasText: name });
    await expect(warning).toContainText('120.00');
    await warning.getByRole('button', { name: m.corrections.importWarnings.keep, exact: true }).click();
    await warning.getByLabel(m.corrections.importWarnings.note).fill(`e2e ${locale}: Green Agro records the return as a correction`);
    await warning.getByRole('button', { name: m.corrections.importWarnings.save, exact: true }).click();
    await expect(owner.getByTestId('import-warning-RETURN_NOT_IMPORTED').filter({ hasText: name })).toHaveCount(0);
    await owner.getByRole('button', { name: m.corrections.importWarnings.showResolved, exact: true }).click();
    await expect(owner.getByTestId('import-warning-RETURN_NOT_IMPORTED').filter({ hasText: name })).toContainText(`e2e ${locale}: Green Agro records the return`);
    await owner.screenshot({ path: shot(`import-warnings-${locale}`), fullPage: true });
  });
}
