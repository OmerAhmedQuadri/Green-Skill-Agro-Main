import {
  canReadMedia, DomainError, isPastRetention, MEDIA_ABANDONED_AFTER_MS, MEDIA_DOWNLOAD_URL_SECONDS, MEDIA_KINDS,
  MEDIA_MAX_BYTES, MEDIA_POLICY, MEDIA_UPLOAD_URL_SECONDS, mediaStorageKey, sniffContentType, type MediaKind,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, eq, lte } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { inTx, writeAudit, type Executor } from '../platform';
import { defaultBranchId, getBlobStore, getDb } from '../runtime';
import { readSettings } from '../system';
import type { PresignedUpload } from './blob-store';

const { mediaAssets } = schema;

export type UploadRequest = {
  readonly kind: MediaKind;
  readonly contentType: string;
  readonly byteSize: number;
  readonly capturedAt?: Date | undefined;
  readonly location?: { readonly lat: number; readonly lng: number; readonly accuracyM?: number | undefined } | undefined;
};
export type UploadTicket = { readonly mediaId: string; readonly upload: PresignedUpload };
export type MediaSummary = {
  readonly id: string; readonly kind: MediaKind; readonly status: 'PENDING' | 'READY' | 'REJECTED' | 'PURGED';
  readonly contentType: string; readonly byteSize: number | null;
};

const summary = (a: typeof mediaAssets.$inferSelect): MediaSummary =>
  ({ id: a.id, kind: a.kind, status: a.status, contentType: a.contentType, byteSize: a.byteSize });

/**
 * Step 1 of an upload (ARCHITECTURE §6.4): check the caller may upload this
 * kind, in this type and size, record it PENDING, and issue a short-lived URL
 * the phone PUTs to directly — the bytes never pass through the app.
 */
export async function requestUpload(ctx: Ctx, input: UploadRequest): Promise<UploadTicket> {
  const policy = MEDIA_POLICY[input.kind];
  authorize(ctx, policy.upload);
  if (!policy.contentTypes.includes(input.contentType)) {
    throw new DomainError('MEDIA_TYPE_NOT_ALLOWED', { kind: input.kind, contentType: input.contentType, allowed: policy.contentTypes });
  }
  if (input.byteSize <= 0 || input.byteSize > MEDIA_MAX_BYTES) throw new DomainError('MEDIA_TOO_LARGE', { maxBytes: MEDIA_MAX_BYTES });

  const id = newId();
  const storageKey = mediaStorageKey(input.kind, id, input.contentType, ctx.now);
  await inTx(ctx, (tx) => tx.insert(mediaAssets).values({
    id, kind: input.kind, storageKey, contentType: input.contentType, uploadedBy: ctx.user.id, branchId: ctx.branchId,
    createdAt: ctx.now, capturedAt: input.capturedAt ?? null,
    capturedLat: input.location ? input.location.lat.toFixed(6) : null,
    capturedLng: input.location ? input.location.lng.toFixed(6) : null,
    captureAccuracyM: input.location?.accuracyM === undefined ? null : input.location.accuracyM.toFixed(1),
  }));
  const upload = await getBlobStore().presignUpload(storageKey, input.contentType, MEDIA_UPLOAD_URL_SECONDS, ctx.now);
  return { mediaId: id, upload };
}

/**
 * Step 3 (SECURITY §5): the object must exist, belong to the caller, be within
 * the size limit, carry the declared type, and *be* that type by its first
 * bytes. Anything else is deleted and rejected. Confirming twice is harmless.
 */
export async function confirmUpload(ctx: Ctx, mediaId: string): Promise<MediaSummary> {
  const [asset] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, mediaId));
  // Someone else's upload is reported as absent, never as forbidden (SECURITY §3).
  if (!asset || asset.uploadedBy !== ctx.user.id || asset.status === 'PURGED') throw new DomainError('NOT_FOUND', { entity: 'media', id: mediaId });
  if (asset.status === 'READY') return summary(asset);
  if (asset.status === 'REJECTED') throw new DomainError('MEDIA_REJECTED', { reason: 'ALREADY_REJECTED' });

  const store = getBlobStore();
  const head = await store.head(asset.storageKey);
  if (!head) throw new DomainError('MEDIA_NOT_UPLOADED');
  const realType = sniffContentType(await store.readPrefix(asset.storageKey, 16));
  const problem =
    head.size === 0 ? 'EMPTY'
      : head.size > MEDIA_MAX_BYTES ? 'TOO_LARGE'
        : head.contentType !== asset.contentType ? 'TYPE_MISMATCH'
          : realType !== asset.contentType ? 'CONTENT_MISMATCH'
            : null;

  if (problem) {
    await store.delete(asset.storageKey);
    // Deliberately outside any request transaction: the rejection must stick
    // even though the error below rolls that transaction back.
    await getDb().update(mediaAssets).set({ status: 'REJECTED' }).where(and(eq(mediaAssets.id, mediaId), eq(mediaAssets.status, 'PENDING')));
    throw new DomainError('MEDIA_REJECTED', { reason: problem });
  }

  const [ready] = await inTx(ctx, (tx) => tx.update(mediaAssets)
    .set({ status: 'READY', byteSize: head.size, confirmedAt: ctx.now })
    .where(and(eq(mediaAssets.id, mediaId), eq(mediaAssets.status, 'PENDING')))
    .returning());
  return summary(ready ?? asset);
}

/** Step 4: a 5-minute signed URL for someone allowed to see it (SECURITY §5). */
export async function mediaDownloadUrl(ctx: Ctx, mediaId: string): Promise<string> {
  const [asset] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, mediaId));
  if (!asset || asset.status !== 'READY' || !canReadMedia(asset.kind, ctx.permissions, asset.uploadedBy === ctx.user.id)) {
    throw new DomainError('NOT_FOUND', { entity: 'media', id: mediaId });
  }
  return getBlobStore().presignDownload(asset.storageKey, MEDIA_DOWNLOAD_URL_SECONDS);
}

/**
 * The daily sweep (worker job `media.retention`): purges photos past the
 * Admin's retention period (OQ-009) and uploads requested but never confirmed. Rows stay as
 * a record; the bytes go. Idempotent.
 */
export async function purgeMedia(now: Date, batch = 500): Promise<{ expired: number; abandoned: number }> {
  const db = getDb();
  const store = getBlobStore();
  const purge = async (asset: typeof mediaAssets.$inferSelect) => {
    await store.delete(asset.storageKey);
    await db.update(mediaAssets).set({ status: 'PURGED', purgedAt: now }).where(eq(mediaAssets.id, asset.id));
  };

  let expired = 0;
  const retentionDays = (await readSettings(db))['media.photo_retention_days'];
  for (const kind of MEDIA_KINDS.filter((k) => MEDIA_POLICY[k].purged)) {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const due = await db.select().from(mediaAssets)
      .where(and(eq(mediaAssets.kind, kind), eq(mediaAssets.status, 'READY'), lte(mediaAssets.createdAt, cutoff))).limit(batch);
    for (const asset of due.filter((a) => isPastRetention(a.kind, a.createdAt, now, retentionDays))) { await purge(asset); expired += 1; }
  }

  const stale = await db.select().from(mediaAssets)
    .where(and(eq(mediaAssets.status, 'PENDING'), lte(mediaAssets.createdAt, new Date(now.getTime() - MEDIA_ABANDONED_AFTER_MS)))).limit(batch);
  for (const asset of stale) await purge(asset);

  if (expired + stale.length > 0) {
    await writeAudit(db, { actorId: null, branchId: await defaultBranchId(), requestId: null, ip: null }, {
      action: 'media.purged', entityType: 'media', after: { expired, abandoned: stale.length },
    });
  }
  return { expired, abandoned: stale.length };
}

/**
 * Evidence attached to a record (a write-off photo, a deposit slip): a
 * confirmed file of the right kind, uploaded by the person attaching it.
 */
export async function assertOwnEvidence(db: Executor, ctx: Ctx, mediaId: string, kind: MediaKind): Promise<void> {
  const [asset] = await db.select({ kind: mediaAssets.kind, status: mediaAssets.status, uploadedBy: mediaAssets.uploadedBy })
    .from(mediaAssets).where(eq(mediaAssets.id, mediaId));
  if (!asset || asset.kind !== kind || asset.uploadedBy !== ctx.user.id) throw new DomainError('EVIDENCE_REQUIRED', { mediaId });
  if (asset.status !== 'READY') throw new DomainError('MEDIA_NOT_UPLOADED', { mediaId });
}
