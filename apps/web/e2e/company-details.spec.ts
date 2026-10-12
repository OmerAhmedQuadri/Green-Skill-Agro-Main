import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { sessionPage, shot } from './helpers';

/**
 * DOC-007 (ADR-0053), in English and Arabic: the Admin enters the company's
 * details once, in Settings, as every delivery document prints them — the
 * words kept as typed, the Arabic typed right to left, the VAT number checked.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Company details (${locale}) — DOC-007: entered once in Settings, as the delivery document prints them`, async ({ browser, baseURL }) => {
    const origin = baseURL ?? '';
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    await admin.goto('/console/settings');
    const company = admin.getByRole('group', { name: m.settings.groups.company });
    // The general settings' own form: the page has a save button on every ceiling and rate too.
    const form = admin.locator('form').filter({ has: company });
    const save = form.getByRole('button', { name: m.common.save, exact: true });
    const nameEn = company.getByLabel(m.settings.fields.company.name_en, { exact: true });
    const nameAr = company.getByLabel(m.settings.fields.company.name_ar, { exact: true });
    const address = company.getByLabel(m.settings.fields.company.address_en, { exact: true });
    const vatNumber = company.getByLabel(m.settings.fields.company.vat_number, { exact: true });
    await expect(nameAr).toHaveAttribute('dir', 'rtl');
    await expect(company.getByLabel(m.settings.fields.vat.rate, { exact: true })).toHaveValue('15');
    await expect(company).toContainText(m.settings.hints.company.vat_number);

    await nameEn.fill(`Example Trading Co. (${locale})`);
    await nameAr.fill('شركة المثال التجارية');
    await address.fill('1234 Example District, Riyadh 12345');
    // Not a VAT number: refused, and nothing is saved.
    await vatNumber.fill('12345');
    await save.click();
    await expect(form.getByRole('alert')).toContainText(m.errors.INVALID_SETTING);
    // Typed in Arabic digits, it is kept in Latin ones (ADR-0026).
    await vatNumber.fill('٣٠٠٠٠٠٠٠٠٠٠٠٠٠٣');
    await save.click();
    await expect(form.getByRole('status')).toContainText(m.common.saved);
    await admin.screenshot({ path: shot(`settings-company-${locale}`), fullPage: true });

    await admin.reload();
    await expect(nameEn).toHaveValue(`Example Trading Co. (${locale})`);
    await expect(nameAr).toHaveValue('شركة المثال التجارية');
    await expect(address).toHaveValue('1234 Example District, Riyadh 12345');
    await expect(vatNumber).toHaveValue('300000000000003');
  });
}
