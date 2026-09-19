import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

// Exercises the real R2 test bucket and its CORS policy, so it runs only when
// S3_ENDPOINT points at R2: locally from .env, in CI from the R2_* secrets under
// the ci/ prefix (TESTING §6). Uploads are removed by the retention sweep.
const usesR2 = /\.r2\.cloudflarestorage\.com$/.test(process.env.S3_ENDPOINT ?? '');

test.describe.serial('M0 — photo upload pipeline in a real browser (ARCHITECTURE §6.4)', () => {
  test.skip(!usesR2, 'needs the R2 development bucket in .env');
  let mediaId = '';

  test('NFR-003: a seller uploads a photo straight to storage, confirms it, and reads it back', async ({ page }) => {
    await signIn(page, 'seller@dev.local');
    const result = await page.evaluate(async () => {
      // A real JPEG, produced the way the phone will: drawn on a canvas, then encoded.
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 48;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no canvas');
      context.fillStyle = '#1b4332';
      context.fillRect(0, 0, 64, 48);
      const photo = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.8));

      const post = (path: string, body: unknown) => fetch(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      const ticketResponse = await post('/media/uploads', { kind: 'SELFIE', contentType: 'image/jpeg', byteSize: photo.size });
      const ticket = (await ticketResponse.json()) as { mediaId: string; upload: { url: string; headers: Record<string, string> } };
      const put = await fetch(ticket.upload.url, { method: 'PUT', headers: ticket.upload.headers, body: photo }); // cross-origin: CORS
      const confirmed = (await (await post(`/media/${ticket.mediaId}/confirm`, {})).json()) as { status: string };
      const read = await fetch(`/api/v1/media/${ticket.mediaId}`); // redirect to a signed R2 URL
      const bytes = new Uint8Array(await read.arrayBuffer());
      return {
        mediaId: ticket.mediaId, requested: ticketResponse.status, uploaded: put.status,
        confirmed: confirmed.status, read: read.status, sameSize: bytes.length === photo.size,
      };
    });
    expect(result).toMatchObject({ requested: 201, uploaded: 200, confirmed: 'READY', read: 200, sameSize: true });
    mediaId = result.mediaId;
  });

  test('SECURITY §5: someone without a read permission for selfies is told it does not exist', async ({ page }) => {
    await signIn(page, 'warehouse@dev.local');
    const response = await page.request.get(`/api/v1/media/${mediaId}`, { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });
});
