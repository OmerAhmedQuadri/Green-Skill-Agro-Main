import { expect, test, type Page } from '@playwright/test';
import m from '../src/messages/en.json' with { type: 'json' };
import { post, sessionPage } from './helpers';

/**
 * ADR-0045: a purchase order's vendor is chosen by someone who can see vendor
 * names — at the latest by the approver, in the approve step. Without names a
 * manager sees the vendor's code and never its name.
 */
const VENDOR_CODE = 'VEN-SAMPLE1';
const VENDOR_NAME = 'Sample Seed House';

async function idOf(page: Page, path: string, find: (item: { id: string; code: string }) => boolean): Promise<string> {
  const body = (await (await page.request.get(`/api/v1${path}`)).json()) as { id: string; code: string }[] | { items: { id: string; code: string }[] };
  const id = (Array.isArray(body) ? body : body.items).find(find)?.id;
  if (!id) throw new Error(`nothing at ${path} — run pnpm db:seed`);
  return id;
}

const okraBag = (page: Page) => idOf(page, '/skus?search=OKRA-PK-5KG', (s) => s.code === 'OKRA-PK-5KG');

test.describe('purchase-order vendor (ADR-0045)', () => {
  test('PO-002: an order drafted without a vendor is approved by choosing one in the approve step', async ({ browser, baseURL }) => {
    const origin = baseURL ?? '';
    const admin = await sessionPage(browser, 'admin@dev.local', 'en', origin);
    const draft = await post(admin, origin, '/purchase-orders', { lines: [{ skuId: await okraBag(admin), orderedPacks: 3, expectedUnitCost: '70' }] });
    await post(admin, origin, `/purchase-orders/${draft.id}/transitions/submit`, { version: draft.version });

    await admin.goto(`/console/purchase-orders/${draft.id}`);
    await expect(admin.getByText(m.procurement.vendorAtApproval).first()).toBeVisible();

    // Approving asks for the vendor first, instead of failing.
    await admin.getByRole('button', { name: m.procurement.actions.approve, exact: true }).first().click();
    await expect(admin.getByText(m.procurement.vendorNeededToApprove)).toBeVisible();
    await admin.getByLabel(m.procurement.vendor).selectOption({ label: `${VENDOR_CODE} · ${VENDOR_NAME}` });
    await admin.getByRole('button', { name: m.procurement.actions.approve, exact: true }).last().click();

    await expect(admin.getByText(m.procurement.statuses.APPROVED, { exact: true }).first()).toBeVisible();
    await expect(admin.getByText(VENDOR_NAME).first()).toBeVisible();
  });

  test('VEN-005: without vendor names a manager sees the code, and never the name', async ({ browser, baseURL }) => {
    const origin = baseURL ?? '';
    const admin = await sessionPage(browser, 'admin@dev.local', 'en', origin);
    const vendorId = await idOf(admin, '/vendor-codes', (v) => v.code === VENDOR_CODE);
    const po = await post(admin, origin, '/purchase-orders', { vendorId, lines: [{ skuId: await okraBag(admin), orderedPacks: 2, expectedUnitCost: '70' }] });

    // The Warehouse preset reads purchase orders but does not include vendor names.
    const warehouse = await sessionPage(browser, 'warehouse@dev.local', 'en', origin);
    for (const path of [`/console/purchase-orders/${po.id}`, '/console/purchase-orders']) {
      await warehouse.goto(path);
      await expect(warehouse.getByText(VENDOR_CODE).first()).toBeVisible(); // loaded, and the code is there
      await expect(warehouse.getByText(VENDOR_NAME)).toHaveCount(0);
    }
  });
});
