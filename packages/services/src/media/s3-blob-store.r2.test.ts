import { randomUUID } from 'node:crypto';
import { loadConfig } from '@gsa/config';
import { afterAll, describe, expect, it } from 'vitest';
import { createS3BlobStore } from './s3-blob-store';

/**
 * Proves the real adapter against the R2 test bucket (ADR-0020). Everything is
 * written under test-runs/<run>/ and deleted afterwards. Output never contains
 * URLs or credentials — only statuses.
 */
const c = loadConfig();
const store = createS3BlobStore({
  endpoint: c.S3_ENDPOINT, region: c.S3_REGION, bucket: c.S3_BUCKET,
  accessKeyId: c.S3_ACCESS_KEY, secretAccessKey: c.S3_SECRET_KEY,
});
const run = `test-runs/${new Date().toISOString().slice(0, 10)}-${randomUUID()}`;
const written: string[] = [];
const key = (name: string) => { const k = `${run}/${name}`; written.push(k); return k; };
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd9]);

afterAll(async () => { for (const k of written) await store.delete(k); });

describe('R2 contract (ADR-0020)', () => {
  it('server-side put, head and delete round-trip', async () => {
    const k = key('server.txt');
    await store.put(k, 'hello from the contract test', 'text/plain');
    expect(await store.head(k)).toEqual({ size: 28, contentType: 'text/plain' });
    await store.delete(k);
    expect(await store.head(k)).toBeNull();
  });

  it('ARCHITECTURE §6.4: a browser-style upload through a presigned URL, read back through a presigned download', async () => {
    const k = key('photo.jpg');
    const upload = await store.presignUpload(k, 'image/jpeg', 300, new Date());
    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: jpeg });
    expect(put.status).toBe(200);
    expect(await store.head(k)).toEqual({ size: jpeg.byteLength, contentType: 'image/jpeg' });
    const get = await fetch(await store.presignDownload(k, 300));
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(jpeg);
  });

  it('SECURITY §5: the first bytes can be read for magic-byte checks', async () => {
    const k = key('prefix.jpg');
    await store.put(k, jpeg, 'image/jpeg');
    expect(await store.readPrefix(k, 4)).toEqual(jpeg.slice(0, 4));
  });

  it('SECURITY §5: a presigned upload is pinned to its content type', async () => {
    const k = key('pinned.jpg');
    const upload = await store.presignUpload(k, 'image/jpeg', 300, new Date());
    const wrongType = await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<script>' });
    expect(wrongType.status).toBe(403);
    expect(await store.head(k)).toBeNull();
  });

  it('SECURITY §5: an expired presigned URL is refused', async () => {
    const k = key('expired.jpg');
    const upload = await store.presignUpload(k, 'image/jpeg', 1, new Date());
    await new Promise((r) => setTimeout(r, 2500));
    const late = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: jpeg });
    expect(late.status).toBe(403);
  });

  it('SECURITY §5: the bucket is private — an unsigned read is refused', async () => {
    const k = key('private.txt');
    await store.put(k, 'private', 'text/plain');
    const unsigned = await fetch(`${c.S3_ENDPOINT}/${c.S3_BUCKET}/${k}`);
    expect([400, 401, 403]).toContain(unsigned.status);
  });

  it('CORS lets the app origin upload directly, and nobody else', async () => {
    const k = key('cors.jpg');
    const upload = await store.presignUpload(k, 'image/jpeg', 300, new Date());
    const preflight = (origin: string) => fetch(upload.url, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
    });
    const ours = await preflight('http://localhost:3000');
    expect(ours.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    const theirs = await preflight('https://evil.example');
    expect(theirs.headers.get('access-control-allow-origin')).toBeNull();
  });
});
