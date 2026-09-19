import type { MediaKind } from '@gsa/core';
import type { Ctx } from '../src/context';
import { confirmUpload, requestUpload } from '../src/media';
import { blobs } from './blobs';
import { ownerQuery } from './db';

export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0xff, 0xd9]);

/** A photo taken, uploaded to the in-memory store and confirmed — as a phone would. */
export async function aPhoto(ctx: Ctx, kind: MediaKind): Promise<string> {
  const ticket = await requestUpload(ctx, { kind, contentType: 'image/jpeg', byteSize: JPEG.byteLength });
  const [row] = await ownerQuery<{ storage_key: string }>(`select storage_key from media_assets where id = $1`, [ticket.mediaId]);
  if (!row) throw new Error('media row missing');
  blobs.completeUpload(row.storage_key, JPEG, 'image/jpeg');
  await confirmUpload(ctx, ticket.mediaId);
  return ticket.mediaId;
}
