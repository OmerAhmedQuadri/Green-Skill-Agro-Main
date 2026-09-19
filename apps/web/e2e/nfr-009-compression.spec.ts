import { expect, test } from '@playwright/test';
import en from '../src/messages/en.json' with { type: 'json' };
import { receiveStock, sessionPage } from './helpers';

const usesR2 = /\.r2\.cloudflarestorage\.com$/.test(process.env.S3_ENDPOINT ?? '');
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);

/** Width and height from a JPEG's start-of-frame segment. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1] ?? 0;
    const length = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  throw new Error('no start-of-frame marker');
}

/**
 * NFR-009, proven in a real browser: a camera-sized photo is compressed on the
 * device before upload — what lands in storage is a JPEG with its long edge
 * at most 1600 px and a fraction of the original's size.
 */
test('NFR-009: a large photo is compressed in the browser before it is uploaded', async ({ browser, baseURL }) => {
  test.skip(!usesR2, 'needs the R2 development bucket in .env');
  test.setTimeout(90_000);
  const origin = baseURL ?? '';
  const lot = `NFR9-${String(Date.now()).slice(-6)}`;
  const admin = await sessionPage(browser, 'admin@dev.local', 'en', origin);
  const { skuId } = await receiveStock(admin, origin, { code: 'OKRA-PK-5KG', packs: 3, lot });
  await admin.goto(`/console/stock/${skuId}`);

  // A 4000 × 3000 photo full of detail, as a phone camera produces.
  const original = Buffer.from(await admin.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 4000;
    canvas.height = 3000;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    for (let y = 0; y < 3000; y += 20) for (let x = 0; x < 4000; x += 20) {
      context.fillStyle = `hsl(${(x * 7 + y * 13) % 360} 70% ${30 + ((x + y) % 40)}%)`;
      context.fillRect(x, y, 20, 20);
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.95));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }), 'base64');
  expect(jpegSize(original)).toEqual({ width: 4000, height: 3000 });

  await admin.getByRole('row').filter({ hasText: lot }).getByRole('button', { name: en.warehouse.writeOff, exact: true }).click();
  await admin.getByLabel(fill(en.warehouse.packsToWriteOff, { held: 3 })).fill('1');
  await admin.getByLabel(en.warehouse.note).fill(`Compression ${lot}`);
  await admin.getByLabel(en.warehouse.takePhoto).setInputFiles({ name: 'camera.jpg', mimeType: 'image/jpeg', buffer: original });
  await admin.getByRole('button', { name: en.warehouse.submitWriteOff }).click();
  await expect(admin.getByRole('status').filter({ hasText: /WO-\d{4}-\d{4}/ })).toBeVisible();

  await admin.goto('/console/write-offs');
  const link = admin.getByRole('row').filter({ hasText: `Compression ${lot}` }).getByRole('link', { name: en.warehouse.viewPhoto });
  const stored = Buffer.from(await (await admin.request.get((await link.getAttribute('href')) ?? '')).body());
  const size = jpegSize(stored);
  expect(Math.max(size.width, size.height)).toBe(1600);
  expect(size.width / size.height).toBeCloseTo(4 / 3, 2);
  expect(stored.length).toBeLessThan(original.length / 3);
});
