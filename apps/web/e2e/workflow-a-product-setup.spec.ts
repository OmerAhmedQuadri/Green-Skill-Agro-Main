import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { sessionPage } from './helpers';

/**
 * Workflow A — setting up a product and its SKUs (WORKFLOWS.md), in English
 * and in Arabic. Runs on the seeded sample catalogue (MIG-006).
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Workflow A (${locale}) — CAT-002, CAT-004, CAT-008, CAT-010, CAT-013, CAT-014, CAT-017, PRC-001, USR-008: an Admin sets up a product, its SKUs and prices`, async ({ browser, baseURL }) => {
    const origin = baseURL ?? '';
    const unique = String(Date.now()).slice(-6);
    const typeName = (code: 'SEEDS' | 'ESSENTIALS') => (code === 'SEEDS' ? (locale === 'ar' ? 'بذور' : 'Seeds') : (locale === 'ar' ? 'مستلزمات زراعية' : 'Agriculture essentials'));

    const page = await sessionPage(browser, 'admin@dev.local', locale, origin);

    await page.goto('/console/catalogue');
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await page.getByRole('link', { name: m.catalogue.newProduct }).click();
    await expect(page).toHaveURL(/\/console\/catalogue\/new$/);

    // CAT-013/014: the type decides the fields — essentials carry no hybrid flag, origin or shelf life.
    await page.getByLabel(m.catalogue.productType).selectOption({ label: typeName('ESSENTIALS') });
    await expect(page.getByLabel(m.catalogue.vendor)).toBeVisible();
    await expect(page.getByLabel(m.catalogue.hybrid)).toHaveCount(0);
    await expect(page.getByLabel(m.catalogue.countryOfOrigin)).toHaveCount(0);
    await page.getByLabel(m.catalogue.productType).selectOption({ label: typeName('SEEDS') });
    await expect(page.getByLabel(m.catalogue.hybrid)).toBeVisible();
    await expect(page.getByLabel(m.catalogue.countryOfOrigin)).toBeVisible();

    // CAT-002: placement from the maintained structure. CAT-004: names in both languages.
    await page.getByLabel(m.catalogue.category, { exact: true }).selectOption({ label: locale === 'ar' ? 'بذور خضروات' : 'Vegetable Seeds' });
    await page.getByLabel(m.catalogue.subCategory).selectOption({ label: locale === 'ar' ? 'غير هجين' : 'Open Pollinated' });
    await page.getByLabel(m.catalogue.productNameEn).fill(`Tomato ${locale} ${unique}`);
    await page.getByLabel(m.catalogue.productNameAr).fill(`طماطم ${unique}`);
    await page.getByLabel(m.catalogue.hybrid).selectOption('NON_HYBRID');
    await page.getByLabel(m.catalogue.countryOfOrigin).selectOption('IN');
    await page.getByLabel(m.catalogue.vendor).selectOption({ label: 'VEN-SAMPLE1' });
    // CAT-017: a default shelf life where the type carries expiry.
    await page.getByLabel(m.catalogue.shelfLife, { exact: false }).fill('24');
    await page.getByRole('button', { name: m.catalogue.createProduct }).click();
    await expect(page).toHaveURL(/\/console\/catalogue\/[0-9a-f-]{36}$/);
    // VEN-005: the Admin holds vendors.view, so the vendor code opens its profile.
    await expect(page.getByRole('link', { name: 'VEN-SAMPLE1' })).toBeVisible();

    // A variety, named in both languages.
    await page.getByRole('button', { name: m.catalogue.addVariety }).first().click();
    await page.getByLabel(m.catalogue.varietyNameEn).fill('Red Round');
    await page.getByLabel(m.catalogue.varietyNameAr).fill('أحمر مدور');
    await page.getByRole('button', { name: m.catalogue.addVariety }).last().click();
    await expect(page.getByRole('cell', { name: 'Red Round' })).toBeVisible();

    // CAT-008/010, PRC-001: a 5 kg bag — the code is proposed, the price entered on the base list.
    await page.getByRole('button', { name: m.catalogue.addSku }).first().click();
    await page.getByLabel(m.catalogue.packSize, { exact: true }).fill('5');
    await page.getByLabel(m.catalogue.unit).selectOption('KG');
    await page.getByLabel(m.catalogue.packaging, { exact: true }).selectOption('BAG');
    const code = page.getByLabel(m.catalogue.skuCode);
    await expect(code).toHaveValue(/^TOMA-RR-5KG/);
    const generated = await code.inputValue();
    const baseList = locale === 'ar' ? 'قائمة الأسعار الأساسية' : 'Base price list';
    await page.getByLabel(m.catalogue.priceOn.replace('{list}', baseList)).fill('86.10');
    await page.getByRole('button', { name: m.catalogue.addSku }).last().click();
    const bagRow = page.getByRole('row').filter({ hasText: generated });
    await expect(bagRow).toContainText('86.10');
    await expect(bagRow.getByText(m.catalogue.customCode)).toHaveCount(0);

    // CAT-008: an overridden code is kept and remembered as custom.
    await page.getByRole('button', { name: m.catalogue.addSku }).first().click();
    await page.getByLabel(m.catalogue.packSize, { exact: true }).fill('1');
    await page.getByLabel(m.catalogue.unit).selectOption('KG');
    await page.getByLabel(m.catalogue.packaging, { exact: true }).selectOption('POUCH');
    await expect(code).toHaveValue(/^TOMA-RR-1KG/);
    await code.fill(`TOM-${locale}-${unique}`);
    await page.getByRole('button', { name: m.catalogue.addSku }).last().click();
    const pouchRow = page.getByRole('row').filter({ hasText: `TOM-${locale.toUpperCase()}-${unique}` });
    await expect(pouchRow.getByText(m.catalogue.customCode)).toBeVisible();

    // USR-008: a manager without catalogue.manage_products sees the catalogue but not the screen to change it.
    const warehouse = await sessionPage(browser, 'warehouse@dev.local', locale, origin);
    await warehouse.goto('/console/catalogue');
    await expect(warehouse.getByRole('heading', { name: m.catalogue.title })).toBeVisible();
    await expect(warehouse.getByRole('link', { name: m.catalogue.newProduct })).toHaveCount(0);
    expect((await warehouse.goto('/console/catalogue/new'))?.status()).toBe(404);

  });
}
