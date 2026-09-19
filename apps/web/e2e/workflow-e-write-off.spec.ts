import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };
import { aJpeg, receiveStock, sessionPage } from './helpers';

type Stock = { batches: { lotNumber: string | null; positions: { warehouse: number } }[] };
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);

/**
 * Workflow E — writing off damaged or expired stock (WORKFLOWS.md), in
 * English and in Arabic: warehouse staff report, a manager decides. The
 * photo goes to R2 for real; in CI through the test bucket's ci/ prefix.
 * The seller's side — from the phone, on vehicle stock — arrives with M4.
 */
for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
  test(`Workflow E (${locale}) — WRO-001..005: warehouse staff report damaged stock with a photo; a manager approves fewer packs or rejects`, async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const origin = baseURL ?? '';
    const lot = `WO-${locale}-${String(Date.now()).slice(-6)}`;
    const admin = await sessionPage(browser, 'admin@dev.local', locale, origin);
    const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 10, lot });
    const heldHere = async () => ((await (await admin.request.get(`/api/v1/stock/${skuId}`)).json()) as Stock).batches.find((b) => b.lotNumber === lot)?.positions.warehouse;

    // WRO-001/002: SKU, batch, quantity, reason and a photo.
    const staff = await sessionPage(browser, 'warehouse@dev.local', locale, origin);
    const report = async (packs: string, note: string, held: number) => {
      await staff.goto(`/console/stock/${skuId}`);
      await staff.getByRole('row').filter({ hasText: lot }).getByRole('button', { name: m.warehouse.writeOff, exact: true }).click();
      await staff.getByLabel(fill(m.warehouse.packsToWriteOff, { held })).fill(packs);
      await staff.getByLabel(m.warehouse.reason).selectOption('DAMAGED');
      await staff.getByLabel(m.warehouse.note).fill(note);
      await staff.getByLabel(m.warehouse.takePhoto).setInputFiles({ name: 'torn-bag.jpg', mimeType: 'image/jpeg', buffer: await aJpeg(staff) });
      await staff.getByRole('button', { name: m.warehouse.submitWriteOff }).click();
      await expect(staff.getByRole('status').filter({ hasText: /WO-\d{4}-\d{4}/ })).toBeVisible();
    };
    await report('3', `Torn bags ${lot}`, 10);
    await expect(staff.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');

    // WRO-003: nothing moves until a decision.
    expect(await heldHere()).toBe(10);

    // WRO-004: the manager sees the photo and approves fewer packs than reported.
    await admin.goto('/console/write-offs');
    const row = admin.getByRole('row').filter({ hasText: `Torn bags ${lot}` });
    await expect(row.getByRole('link', { name: m.warehouse.viewPhoto })).toHaveAttribute('href', /\/api\/v1\/media\//);
    const photo = await admin.request.get((await row.getByRole('link', { name: m.warehouse.viewPhoto }).getAttribute('href')) ?? '');
    expect(photo.status()).toBe(200);
    await row.getByRole('button', { name: m.warehouse.decide }).click();
    await admin.getByLabel(fill(m.warehouse.approvedPacks, { max: 3 })).fill('2');
    await admin.getByLabel(m.warehouse.comment, { exact: true }).fill('One bag is fine');
    await admin.getByRole('button', { name: m.warehouse.approve, exact: true }).click();
    // WRO-005: the holding location's stock falls by what was approved.
    await expect.poll(heldHere).toBe(8);

    // WRO-004: a rejection returns the report with a comment; nothing moves.
    await report('1', `Scuffed ${lot}`, 8);
    await admin.goto('/console/write-offs');
    const second = admin.getByRole('row').filter({ hasText: `Scuffed ${lot}` });
    await second.getByRole('button', { name: m.warehouse.decide }).click();
    await admin.getByLabel(m.warehouse.rejectComment).fill('Still saleable');
    await admin.getByRole('button', { name: m.warehouse.reject, exact: true }).click();
    await admin.getByLabel(m.common.status).selectOption('REJECTED');
    await expect(admin.getByRole('row').filter({ hasText: `Scuffed ${lot}` })).toContainText('Still saleable');
    expect(await heldHere()).toBe(8);

    // Four-eyes: nobody is offered a decision on their own report.
    await admin.goto(`/console/stock/${skuId}`);
    await admin.getByRole('row').filter({ hasText: lot }).getByRole('button', { name: m.warehouse.writeOff, exact: true }).click();
    await admin.getByLabel(fill(m.warehouse.packsToWriteOff, { held: 8 })).fill('1');
    await admin.getByLabel(m.warehouse.note).fill(`Own report ${lot}`);
    await admin.getByLabel(m.warehouse.takePhoto).setInputFiles({ name: 'own.jpg', mimeType: 'image/jpeg', buffer: await aJpeg(admin) });
    await admin.getByRole('button', { name: m.warehouse.submitWriteOff }).click();
    await admin.goto('/console/write-offs');
    await expect(admin.getByRole('row').filter({ hasText: `Own report ${lot}` }).getByRole('button', { name: m.warehouse.decide })).toHaveCount(0);
  });
}
