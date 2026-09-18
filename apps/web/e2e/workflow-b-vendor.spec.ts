import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { sessionPage } from './helpers';

type Category = { id: string; nameEn: string; subCategories: { id: string; nameEn: string }[] };
type ProductType = { id: string; code: string };

/** Workflow B — creating a vendor profile (WORKFLOWS.md), in English and in Arabic. */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Workflow B (${locale}) — VEN-001, VEN-002, VEN-005: an Admin creates a vendor; its code links only for those with vendor access`, async ({ browser, baseURL }) => {
    const origin = baseURL ?? '';
    const unique = String(Date.now()).slice(-6);
    const vendorCode = `VEN-${locale.toUpperCase()}${unique}`;

    const page = await sessionPage(browser, 'admin@dev.local', locale, origin);

    // VEN-001/002: the Admin creates a vendor with all seven fields.
    await page.goto('/console/vendors');
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await page.getByRole('button', { name: m.vendors.newVendor }).click();
    await page.getByLabel(m.vendors.code).fill(vendorCode);
    await page.getByLabel(m.vendors.name, { exact: true }).fill(`Seed House ${unique}`);
    await page.getByLabel(m.vendors.country).selectOption('IN');
    await page.getByLabel(m.vendors.contactPerson).fill('A. Kumar');
    await page.getByLabel(m.vendors.phone).fill('+91 98123 45678');
    await page.getByLabel(m.vendors.email).fill(`sales${unique}@example.com`);
    await page.getByLabel(m.vendors.address).fill('Plot 12, Pune');
    await page.getByRole('button', { name: m.vendors.create }).click();
    const link = page.getByRole('link', { name: vendorCode });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByText('+919812345678')).toBeVisible();
    await expect(page.getByText('Plot 12, Pune')).toBeVisible();

    // A product naming this vendor, made through the API.
    const vendorId = page.url().split('/').at(-1) ?? '';
    const categories = (await (await page.request.get('/api/v1/categories')).json()) as Category[];
    const types = (await (await page.request.get('/api/v1/product-types')).json()) as ProductType[];
    const seeds = categories.find((c) => c.nameEn === 'Vegetable Seeds');
    const sub = seeds?.subCategories.find((s) => s.nameEn === 'Open Pollinated');
    const created = await page.request.post('/api/v1/products', {
      headers: { origin, 'idempotency-key': crypto.randomUUID() },
      data: {
        productTypeId: types.find((t) => t.code === 'SEEDS')?.id, categoryId: seeds?.id, subCategoryId: sub?.id,
        nameEn: `Pepper ${locale} ${unique}`, nameAr: `فلفل ${unique}`, hybrid: 'HYBRID', countryOfOrigin: 'IN', vendorId,
      },
    });
    expect(created.status()).toBe(201);
    const { id: productId } = (await created.json()) as { id: string };

    // VEN-005: with vendors.view the code opens the profile...
    await page.goto(`/console/catalogue/${productId}`);
    await expect(page.getByRole('link', { name: vendorCode })).toHaveAttribute('href', `/console/vendors/${vendorId}`);

    // ...without it, the code is shown as plain text.
    const warehouse = await sessionPage(browser, 'warehouse@dev.local', locale, origin);
    await warehouse.goto(`/console/catalogue/${productId}`);
    await expect(warehouse.getByText(vendorCode)).toBeVisible();
    await expect(warehouse.getByRole('link', { name: vendorCode })).toHaveCount(0);
    expect((await warehouse.goto(`/console/vendors/${vendorId}`))?.status()).toBe(404);

  });
}
