import { expect, type Browser, type Page } from '@playwright/test';

export const PASSWORD = process.env.DEV_SEED_PASSWORD ?? '';
export const shot = (name: string) => `${process.env.SCREENSHOT_DIR ?? 'test-results/screenshots'}/${name}.png`;

/** Seeded development accounts (DEVELOPMENT §7). */
export async function signIn(page: Page, identifier: string): Promise<void> {
  expect(PASSWORD.length, 'DEV_SEED_PASSWORD must be set').toBeGreaterThanOrEqual(10);
  await page.goto('/login');
  await page.locator('#identifier').fill(identifier);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** Accounts signed in once by the global setup and shared by every spec. */
export const SESSIONS = ['admin@dev.local', 'warehouse@dev.local', 'manager@dev.local'] as const;
export type SessionAccount = (typeof SESSIONS)[number];
export const sessionFile = (account: SessionAccount) => `.auth/${account.replace(/[^a-z]/g, '-')}.json`;

/**
 * A page already signed in as a shared account, in the given language. The
 * language is this browser's cookie only, so specs running side by side in
 * different languages never disturb each other.
 */
export async function sessionPage(browser: Browser, account: SessionAccount, locale: 'en' | 'ar', baseURL: string): Promise<Page> {
  const context = await browser.newContext({ baseURL, storageState: sessionFile(account) });
  await context.addCookies([{ name: 'NEXT_LOCALE', value: locale, url: baseURL }]);
  return context.newPage();
}

type Json = Record<string, unknown>;
const post = async (page: Page, origin: string, path: string, data: Json) => {
  const response = await page.request.post(`/api/v1${path}`, { headers: { origin, 'idempotency-key': crypto.randomUUID() }, data });
  if (!response.ok()) throw new Error(`${path}: ${response.status()} ${await response.text()}`);
  return (await response.json()) as Json & { id: string; version: number };
};

/**
 * Stock in the warehouse, received through the real purchase-order path, for
 * specs that start from stock on hand. Needs a page signed in as an Admin.
 */
export async function receiveStock(page: Page, origin: string, input: { code: string; packs: number; lot: string; expiresOn?: string }) {
  const skus = (await (await page.request.get(`/api/v1/skus?search=${encodeURIComponent(input.code)}`)).json()) as { items: { id: string; code: string }[] };
  const sku = skus.items.find((s) => s.code === input.code);
  const vendors = (await (await page.request.get('/api/v1/vendor-codes')).json()) as { id: string; code: string }[];
  if (!sku || !vendors[0]) throw new Error(`no SKU ${input.code} or vendor — run pnpm db:seed`);
  let po = await post(page, origin, '/purchase-orders', { vendorId: vendors[0].id, lines: [{ skuId: sku.id, orderedPacks: input.packs, expectedUnitCost: '10' }] });
  for (const step of ['submit', 'approve', 'place']) po = await post(page, origin, `/purchase-orders/${po.id}/transitions/${step}`, { version: po.version });
  const line = (po.lines as { id: string }[])[0];
  await post(page, origin, `/purchase-orders/${po.id}/receipts`, {
    version: po.version,
    lines: [{ purchaseOrderLineId: line?.id, packs: input.packs, lotNumber: input.lot, manufacturedOn: '2026-01-10', expiresOn: input.expiresOn ?? '2027-12-31' }],
  });
  return { skuId: sku.id };
}

/** A real JPEG, encoded by the browser from a canvas — what a phone camera hands the app. */
export async function aJpeg(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    context.fillStyle = '#7f1d1d';
    context.fillRect(0, 0, 64, 48);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.8));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  });
  return Buffer.from(base64, 'base64');
}
