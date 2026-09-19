import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import writeXlsxFile from 'write-excel-file/node';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { sessionPage } from './helpers';

type Po = { id: string; number: string; version: number; lines: { id: string; code: string }[] };
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);
// The business day is Riyadh's (CONVENTIONS §4), which can be a day ahead of UTC.
const isoInDays = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date(Date.now() + days * 86_400_000));

/** The text an ICU plural message renders for a count — enough of ICU for these messages. */
function plural(message: string, count: number, locale: 'en' | 'ar'): string {
  const rule = count === 0 && /\bzero \{/.test(message) ? 'zero' : new Intl.PluralRules(locale).select(count);
  const branch = new RegExp(`\\b${rule} \\{([^}]*)\\}`).exec(message) ?? /\bother \{([^}]*)\}/.exec(message);
  return (branch?.[1] ?? message).replace('#', String(count));
}

/**
 * Workflow C — raising and receiving a purchase order (WORKFLOWS.md), in
 * English and in Arabic, on the seeded sample catalogue (MIG-006).
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  // An Arabic keyboard types Arabic-Indic digits and the Arabic decimal separator (ADR-0026).
  const n = (v: string) => (locale === 'ar' ? v.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d).replace('.', '٫') : v);
  test(`Workflow C (${locale}) — PO-001, PO-003, PO-004, PO-005, PO-006, PO-007, STK-007, RCV-001..007: a manager raises an order, an Admin approves and receives it`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const origin = baseURL ?? '';
    const unique = String(Date.now()).slice(-6);
    const manager = await sessionPage(browser, 'manager@dev.local', locale, origin);
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    const action = (p: Page, key: keyof typeof m.procurement.actions) => p.getByRole('button', { name: m.procurement.actions[key], exact: true });
    const status = (p: Page, key: keyof typeof m.procurement.statuses) => p.getByText(m.procurement.statuses[key], { exact: true }).first();

    // PO-002/003: a permitted manager enters the order and submits it.
    await manager.goto('/console/purchase-orders/new');
    await expect(manager.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await manager.getByLabel(m.procurement.vendor).selectOption({ label: 'VEN-SAMPLE1' });
    await manager.getByLabel(m.procurement.expectedArrival).fill(isoInDays(10));
    for (const [code, packs, cost] of [['OKRA-PK-5KG', '20', '70.00'], ['OKRA-PK-1KG', '10', '16.50']] as const) {
      await manager.getByLabel(m.procurement.addSku).fill(code);
      await manager.getByRole('button', { name: new RegExp(`^${code}`) }).click();
      await manager.getByLabel(fill(m.procurement.packsFor, { code })).fill(n(packs));
      await manager.getByLabel(fill(m.procurement.costFor, { code })).fill(n(cost));
    }
    await manager.getByRole('button', { name: m.procurement.saveDraft }).click();
    await expect(manager).toHaveURL(/\/console\/purchase-orders\/[0-9a-f-]{36}$/);
    const poId = manager.url().split('/').at(-1) ?? '';
    await action(manager, 'submit').click();
    await expect(status(manager, 'PENDING_APPROVAL')).toBeVisible();
    // PO-003: approval always rests with an Admin.
    await expect(action(manager, 'approve')).toHaveCount(0);

    // PO-001: the Admin approves and places it; the supplier confirms and despatches.
    await admin.goto(`/console/purchase-orders/${poId}`);
    for (const [step, reached] of [['approve', 'APPROVED'], ['place', 'PLACED'], ['confirm', 'CONFIRMED'], ['despatch', 'IN_TRANSIT']] as const) {
      await action(admin, step).click();
      await expect(status(admin, reached)).toBeVisible();
    }
    const number = (await admin.request.get(`/api/v1/purchase-orders/${poId}`).then((r) => r.json()) as Po).number;

    // PO-004, STK-007: in transit, it is incoming — with a countdown — not stock.
    await admin.goto('/console/incoming');
    const incomingRow = admin.getByRole('row').filter({ hasText: number }).filter({ hasText: 'OKRA-PK-5KG' });
    await expect(incomingRow).toContainText('20');
    await expect(incomingRow).toContainText('10'); // days to arrival, in Latin digits in both languages (ADR-0026)

    // RCV-003..006: line by line — 12 of 20 bags with dates; the pouches with a shelf-life period.
    await admin.goto(`/console/purchase-orders/${poId}`);
    await admin.getByRole('button', { name: m.receiving.receive, exact: true }).click();
    // Rows are in SKU-code order: the 1 kg pouch, then the 5 kg bag.
    await admin.getByLabel(fill(m.receiving.lotFor, { row: 1 })).fill(`E2E-${unique}`);
    await admin.getByLabel(fill(m.receiving.mfdFor, { row: 1 })).fill('2026-01-10');
    await admin.getByLabel(fill(m.receiving.shelfLifeFor, { row: 1 })).fill('12');
    await admin.getByLabel(fill(m.receiving.packsFor, { code: 'OKRA-PK-5KG', row: 2 })).fill('12');
    await admin.getByLabel(fill(m.receiving.lotFor, { row: 2 })).fill(`E2E-${unique}`);
    await admin.getByLabel(fill(m.receiving.mfdFor, { row: 2 })).fill('2026-01-10');
    await admin.getByLabel(fill(m.receiving.expiryFor, { row: 2 })).fill('2027-12-31');
    await admin.getByRole('button', { name: m.receiving.confirmReceipt }).click();
    // RCV-007: short, so it stays open for the balance.
    await expect(status(admin, 'PARTIALLY_RECEIVED')).toBeVisible();

    // RCV-001/002: the template as downloaded still lacks LOT numbers — the row is flagged, nothing can be committed.
    await admin.getByRole('button', { name: m.receiving.import, exact: true }).click();
    const download = admin.waitForEvent('download');
    await admin.getByRole('link', { name: m.receiving.downloadTemplate }).click();
    const template = await download;
    expect(template.suggestedFilename()).toBe(`${number}-receipt.xlsx`);
    const upload = admin.locator('input[type="file"]');
    const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    await upload.setInputFiles({ name: 'as-downloaded.xlsx', mimeType: xlsxType, buffer: await readFile(await template.path()) });
    await expect(admin.getByText(plural(m.receiving.invalidRows, 1, locale), { exact: true })).toBeVisible();
    await expect(admin.getByRole('cell', { name: m.errors.ATTRIBUTE_REQUIRED, exact: false })).toBeVisible();
    await expect(admin.getByRole('button', { name: plural(m.receiving.confirmImport, 0, locale) })).toBeDisabled();

    // A filled file: one good row, one for a SKU not on the order. Only the good one is committed.
    const filled = await writeXlsxFile([
      ['sku', 'product', 'packs', 'lot', 'mfd', 'expiry', 'shelf', 'cost'],
      ['OKRA-PK-5KG', '', 5, `IMP-${unique}`, '2026-02-01', '2027-12-31', null, '70'],
      ['NOT-ON-ORDER', '', 1, 'X', '2026-02-01', null, null, null],
    ]).toBuffer();
    await upload.setInputFiles({ name: `arrival-${unique}.xlsx`, mimeType: xlsxType, buffer: filled });
    await expect(admin.getByRole('cell', { name: m.errors.SKU_NOT_ON_ORDER, exact: false })).toBeVisible();
    await expect(admin.getByText(plural(m.receiving.validRows, 1, locale), { exact: true })).toBeVisible();
    const receiptsBefore = (await admin.request.get(`/api/v1/purchase-orders/${poId}`).then((r) => r.json()) as { receipts: unknown[] }).receipts;
    expect(receiptsBefore).toHaveLength(1); // previewing wrote nothing
    await admin.getByRole('button', { name: plural(m.receiving.confirmImport, 1, locale) }).click();
    // Saved once the preview closes: the file's name shows in the preview too, and acting sooner uses the order's old version.
    await expect(admin.getByText(plural(m.receiving.validRows, 1, locale), { exact: true })).toHaveCount(0);
    await expect(admin.getByText(`arrival-${unique}.xlsx`)).toBeVisible();

    // PO-007: 3 bags will not come — close short, with a reason.
    await action(admin, 'close_short').click();
    await admin.getByLabel(m.procurement.reason).fill('Vendor short-shipped');
    await admin.getByRole('button', { name: m.procurement.actions.close_short }).last().click();
    await expect(admin.getByText(m.procurement.closeReasons.SHORT, { exact: true }).first()).toBeVisible();

    // PO-005/006: another order, cancelled while in transit, leaves incoming stock at once.
    const create = await manager.request.post('/api/v1/purchase-orders', {
      headers: { origin, 'idempotency-key': crypto.randomUUID() },
      data: { vendorId: (await manager.request.get('/api/v1/vendor-codes').then((r) => r.json()) as { id: string; code: string }[]).find((v) => v.code === 'VEN-SAMPLE1')?.id,
        expectedArrival: isoInDays(20), lines: [{ skuId: (await admin.request.get('/api/v1/skus?search=OKRA-PK-50G').then((r) => r.json()) as { items: { id: string }[] }).items[0]?.id, orderedPacks: 7, expectedUnitCost: '12' }] },
    });
    let other = await create.json() as Po;
    for (const [p, step] of [[manager, 'submit'], [admin, 'approve'], [admin, 'place'], [admin, 'despatch']] as const) {
      other = await (await p.request.post(`/api/v1/purchase-orders/${other.id}/transitions/${step}`, { headers: { origin, 'idempotency-key': crypto.randomUUID() }, data: { version: other.version } })).json() as Po;
    }
    await admin.goto('/console/incoming');
    await expect(admin.getByRole('row').filter({ hasText: other.number })).toHaveCount(1);
    await admin.goto(`/console/purchase-orders/${other.id}`);
    await action(admin, 'cancel').click();
    await admin.getByLabel(m.procurement.reason).fill('Vendor withdrew');
    await admin.getByRole('button', { name: m.procurement.actions.cancel }).last().click();
    await expect(admin.getByText(m.procurement.closeReasons.CANCELLED, { exact: true }).first()).toBeVisible();
    await admin.goto('/console/incoming');
    await expect(admin.getByRole('row').filter({ hasText: other.number })).toHaveCount(0);
  });
}
