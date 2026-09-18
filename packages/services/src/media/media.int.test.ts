import { presetOverrides, PRESET_DEFAULTS, type DomainError } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { blobs } from '../../test/blobs';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { confirmUpload, mediaDownloadUrl, purgeMedia, requestUpload } from './uploads';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const code = (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code);
const keyOf = async (id: string) => (await ownerQuery<{ storage_key: string }>('select storage_key from media_assets where id = $1', [id]))[0]?.storage_key ?? '';

/** Request, then "upload" as the phone would, then confirm. */
async function uploadSelfie(ctx: Awaited<ReturnType<typeof ctxFor>>, bytes = JPEG, declared = 'image/jpeg') {
  const ticket = await requestUpload(ctx, { kind: 'SELFIE', contentType: 'image/jpeg', byteSize: bytes.byteLength });
  blobs.completeUpload(await keyOf(ticket.mediaId), bytes, declared);
  return ticket.mediaId;
}

describe('photo upload pipeline (ARCHITECTURE §6.4, SECURITY §5)', () => {
  it('NFR-003: a seller requests a selfie upload, uploads it directly, and confirms it', async () => {
    const ctx = await ctxFor(await anAccount('SELLER'));
    const ticket = await requestUpload(ctx, { kind: 'SELFIE', contentType: 'image/jpeg', byteSize: JPEG.byteLength, location: { lat: 24.7136, lng: 46.6753, accuracyM: 12 } });
    expect(ticket.upload.headers['content-type']).toBe('image/jpeg');
    const key = await keyOf(ticket.mediaId);
    expect(key).toMatch(/^selfie\/\d{4}-\d{2}\/[0-9a-f-]{36}\.jpg$/);
    blobs.completeUpload(key, JPEG, 'image/jpeg');
    expect(await confirmUpload(ctx, ticket.mediaId)).toMatchObject({ status: 'READY', byteSize: JPEG.byteLength });
    const [row] = await ownerQuery<{ captured_lat: string }>('select captured_lat from media_assets where id = $1', [ticket.mediaId]);
    expect(row?.captured_lat).toBe('24.713600');
  });

  it('SECURITY §5: a kind the caller may not upload is refused', async () => {
    const ctx = await ctxFor(await anAccount('SELLER'));
    expect(await code(requestUpload(ctx, { kind: 'TRANSPORT_SLIP', contentType: 'image/jpeg', byteSize: 10 }))).toBe('FORBIDDEN');
  });

  it('SECURITY §5: a type the kind does not accept, or an oversize file, is refused up front', async () => {
    const ctx = await ctxFor(await anAccount('SELLER'));
    expect(await code(requestUpload(ctx, { kind: 'SELFIE', contentType: 'image/png', byteSize: 10 }))).toBe('MEDIA_TYPE_NOT_ALLOWED');
    expect(await code(requestUpload(ctx, { kind: 'SELFIE', contentType: 'image/jpeg', byteSize: 10 * 1024 * 1024 + 1 }))).toBe('MEDIA_TOO_LARGE');
  });

  it('confirming before the upload arrives says so, and leaves the request usable', async () => {
    const ctx = await ctxFor(await anAccount('SELLER'));
    const ticket = await requestUpload(ctx, { kind: 'SELFIE', contentType: 'image/jpeg', byteSize: JPEG.byteLength });
    expect(await code(confirmUpload(ctx, ticket.mediaId))).toBe('MEDIA_NOT_UPLOADED');
    blobs.completeUpload(await keyOf(ticket.mediaId), JPEG, 'image/jpeg');
    expect((await confirmUpload(ctx, ticket.mediaId)).status).toBe('READY');
  });

  it('SECURITY §5: a file that is not what it claims is deleted and rejected — and stays rejected', async () => {
    const ctx = await ctxFor(await anAccount('SELLER'));
    const mediaId = await uploadSelfie(ctx, PNG, 'image/jpeg'); // PNG bytes labelled as JPEG
    expect(await code(confirmUpload(ctx, mediaId))).toBe('MEDIA_REJECTED');
    expect(blobs.keys()).toHaveLength(0);
    expect((await ownerQuery<{ status: string }>('select status from media_assets where id = $1', [mediaId]))[0]?.status).toBe('REJECTED');
  });

  it('SECURITY §3: only the uploader can confirm; anyone else is told it does not exist', async () => {
    const owner = await ctxFor(await anAccount('SELLER'));
    const other = await ctxFor(await anAccount('SELLER'));
    const mediaId = await uploadSelfie(owner);
    expect(await code(confirmUpload(other, mediaId))).toBe('NOT_FOUND');
  });

  it('confirming twice is harmless', async () => {
    const ctx = await ctxFor(await anAccount('SELLER'));
    const mediaId = await uploadSelfie(ctx);
    await confirmUpload(ctx, mediaId);
    expect((await confirmUpload(ctx, mediaId)).status).toBe('READY');
  });

  it('SECURITY §5: a photo is readable by its uploader and by holders of a read permission — nobody else', async () => {
    const seller = await ctxFor(await anAccount('SELLER'));
    const mediaId = await uploadSelfie(seller);
    await confirmUpload(seller, mediaId);
    const warehouse = await ctxFor(await anAccount('MANAGER'), { overrides: presetOverrides(PRESET_DEFAULTS.WAREHOUSE) });
    const sales = await ctxFor(await anAccount('MANAGER'), { overrides: presetOverrides(PRESET_DEFAULTS.SALES_MANAGER) });
    expect(await mediaDownloadUrl(seller, mediaId)).toContain('memory://');
    expect(await mediaDownloadUrl(sales, mediaId)).toContain('memory://'); // attendance.view
    expect(await code(mediaDownloadUrl(warehouse, mediaId))).toBe('NOT_FOUND');
  });

  it('OQ-009: selfies are purged after 90 days; abandoned uploads after a day; storefronts are kept', async () => {
    const t0 = new Date('2026-01-01T08:00:00Z');
    const seller = await ctxFor(await anAccount('SELLER'), { now: t0 });
    const selfie = await uploadSelfie(seller);
    await confirmUpload(seller, selfie);
    const storefront = await requestUpload(seller, { kind: 'STOREFRONT', contentType: 'image/jpeg', byteSize: JPEG.byteLength });
    blobs.completeUpload(await keyOf(storefront.mediaId), JPEG, 'image/jpeg');
    await confirmUpload(seller, storefront.mediaId);
    const abandoned = await requestUpload(seller, { kind: 'SELFIE', contentType: 'image/jpeg', byteSize: 10 });

    expect(await purgeMedia(new Date('2026-01-01T20:00:00Z'))).toEqual({ expired: 0, abandoned: 0 });
    expect(await purgeMedia(new Date('2026-01-02T09:00:00Z'))).toEqual({ expired: 0, abandoned: 1 });
    expect(await purgeMedia(new Date('2026-04-02T09:00:00Z'))).toEqual({ expired: 1, abandoned: 0 });

    const status = async (id: string) => (await ownerQuery<{ status: string }>('select status from media_assets where id = $1', [id]))[0]?.status;
    expect(await status(selfie)).toBe('PURGED');
    expect(await status(abandoned.mediaId)).toBe('PURGED');
    expect(await status(storefront.mediaId)).toBe('READY');
    expect(blobs.keys()).toEqual([await keyOf(storefront.mediaId)]);
    expect(await code(mediaDownloadUrl(seller, selfie))).toBe('NOT_FOUND');
  });
});
