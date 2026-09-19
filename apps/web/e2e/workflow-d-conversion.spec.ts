import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { receiveStock, sessionPage } from './helpers';

type Sku = { batches: { lotNumber: string | null; manufacturedOn: string | null; expiresOn: string | null; positions: { warehouse: number } }[] };
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);

/** Workflow D — converting SKU or repackaging (WORKFLOWS.md), in English and in Arabic. */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Workflow D (${locale}) — CNV-002, CNV-004, CNV-005, CNV-006, CNV-007, CNV-008, CNV-011, WRO-006: warehouse staff repackage bags into pouches`, async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const origin = baseURL ?? '';
    const lot = `CV-${locale}-${String(Date.now()).slice(-6)}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    const { skuId: bagId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 10, lot, expiresOn: '2027-11-30' });
    const pouchId = ((await (await admin.request.get('/api/v1/skus?search=OKRA-PK-1KG')).json()) as { items: { id: string; code: string }[] }).items.find((s) => s.code === 'OKRA-PK-1KG')?.id ?? '';

    // Warehouse staff: source is a batch; the target list offers only the same variety and measure (CNV-002).
    const staff = await sessionPage(browser, 'warehouse@dev.local', locale, origin);
    await staff.goto(`/console/stock/${bagId}`);
    await expect(staff.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    const row = staff.getByRole('row').filter({ hasText: lot });
    await row.getByRole('button', { name: m.warehouse.convert, exact: true }).click();
    const targetOptions = staff.getByLabel(m.warehouse.targetSku).locator('option');
    await expect(targetOptions.filter({ hasText: 'OKRA-PK-1KG' })).toHaveCount(1);
    await expect(targetOptions.filter({ hasText: 'OKRA-PK-5KG' })).toHaveCount(0); // not itself
    await expect(targetOptions.filter({ hasText: 'CARR-' })).toHaveCount(0); // not another product
    const staffTarget = staff.getByLabel(m.warehouse.targetSku);
    await staffTarget.selectOption((await staffTarget.locator('option', { hasText: 'OKRA-PK-1KG' }).first().getAttribute('value')) ?? '');
    // CNV-004: this user may not set prices, so the price field is absent.
    await expect(staff.getByLabel(m.warehouse.targetPrice)).toHaveCount(0);

    // CNV-011: 1 bag cannot make 6 pouches.
    await staff.getByLabel(fill(m.warehouse.sourcePacks, { held: 10 })).fill('1');
    await staff.getByLabel(m.warehouse.targetPacks).fill('6');
    await staff.getByLabel(m.warehouse.reason, { exact: true }).fill('Retail demand');
    await staff.locator('form').getByRole('button', { name: m.warehouse.convert, exact: true }).click();
    await expect(staff.getByRole('alert').filter({ hasText: m.errors.CONVERSION_UNBALANCED })).toBeVisible();

    // 2 bags into 9 pouches: the loss (1 kg) is derived and written off (CNV-005, WRO-006).
    await staff.getByLabel(fill(m.warehouse.sourcePacks, { held: 10 })).fill('2');
    await staff.getByLabel(m.warehouse.targetPacks).fill('9');
    await staff.locator('form').getByRole('button', { name: m.warehouse.convert, exact: true }).click();
    await expect(staff.getByText(fill(m.warehouse.converted, { from: 2, to: 9, code: 'OKRA-PK-1KG' }))).toBeVisible();
    await expect(row).toContainText('8');

    // CNV-006: the pouches carry the bags' LOT, manufacture and expiry dates.
    const pouches = (await (await admin.request.get(`/api/v1/stock/${pouchId}`)).json()) as Sku;
    expect(pouches.batches.find((b) => b.lotNumber === lot)).toMatchObject({ manufacturedOn: '2026-01-10', expiresOn: '2027-11-30', positions: { warehouse: 9 } });

    // WRO-006, CNV-007/008: the loss is an approved write-off, recorded with who and why; nothing waited for approval.
    const writeOffs = (await (await admin.request.get('/api/v1/write-offs?status=APPROVED')).json()) as { items: { reason: string; lotNumber: string; note: string; submittedBy: { name: string } }[] };
    expect(writeOffs.items.find((w) => w.lotNumber === lot)).toMatchObject({ reason: 'CONVERSION_LOSS', note: 'Retail demand', submittedBy: { name: 'Dev Warehouse' } });

    // CNV-004: an Admin can set the target's price as part of a conversion.
    await admin.goto(`/console/stock/${bagId}`);
    await admin.getByRole('row').filter({ hasText: lot }).getByRole('button', { name: m.warehouse.convert, exact: true }).click();
    const target = admin.getByLabel(m.warehouse.targetSku);
    await target.selectOption((await target.locator('option', { hasText: 'OKRA-PK-1KG' }).first().getAttribute('value')) ?? '');
    await admin.getByLabel(fill(m.warehouse.sourcePacks, { held: 8 })).fill('1');
    await admin.getByLabel(m.warehouse.targetPacks).fill('5');
    await admin.getByLabel(m.warehouse.reason, { exact: true }).fill('Price review');
    await admin.getByLabel(m.warehouse.targetPrice).fill('26.00');
    await admin.locator('form').getByRole('button', { name: m.warehouse.convert, exact: true }).click();
    await expect(admin.getByText(fill(m.warehouse.converted, { from: 1, to: 5, code: 'OKRA-PK-1KG' }))).toBeVisible();
    const skus = (await (await admin.request.get('/api/v1/skus?search=OKRA-PK-1KG')).json()) as { items: { code: string; basePrice: string }[] };
    expect(skus.items.find((s) => s.code === 'OKRA-PK-1KG')?.basePrice).toBe('26.00');
  });
}
