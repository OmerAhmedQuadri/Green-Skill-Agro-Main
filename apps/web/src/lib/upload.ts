import { ApiError, api } from './api';

/**
 * Photo upload from the browser (ARCHITECTURE §6.4): compress, request a URL,
 * upload straight to storage, confirm. Every step retries network failures,
 * reusing its idempotency key, so a flaky connection never creates duplicates.
 */
export type MediaKind = 'SELFIE' | 'ODOMETER' | 'STOREFRONT' | 'WRITE_OFF_EVIDENCE' | 'DEPOSIT_SLIP' | 'TRANSPORT_SLIP';
export type Capture = { capturedAt?: Date; location?: { lat: number; lng: number; accuracyM?: number } };
type Ticket = { mediaId: string; upload: { url: string; headers: Record<string, string>; expiresAt: string } };

/** Kinds stored only as JPEG photos; slips may also be a PNG screenshot or a PDF. */
const PHOTO_ONLY: ReadonlySet<MediaKind> = new Set(['SELFIE', 'ODOMETER', 'STOREFRONT', 'WRITE_OFF_EVIDENCE']);

/**
 * Long edge ≤ 1600 px, JPEG quality 0.8. Re-encoding through a canvas also
 * drops EXIF metadata, including embedded GPS (SECURITY §5).
 */
export async function compressPhoto(file: Blob, maxEdge = 1600, quality = 0.8): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new ApiError(0, 'UPLOAD_FAILED');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new ApiError(0, 'UPLOAD_FAILED'))), 'image/jpeg', quality);
  });
}

/**
 * Worth trying again: the connection failed, or storage is busy or briefly
 * unwell. Not a 4xx — an expired signature or a content type that does not
 * match the one signed will fail identically three times over and only make
 * the person wait three times as long for the same answer.
 */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

const worthRetrying = (error: unknown): boolean =>
  error instanceof ApiError && (error.code === 'NETWORK_ERROR' || RETRYABLE_STATUS.has(error.status));

/**
 * A stalled upload has to be abandoned rather than waited on. A dead
 * connection never settles, so without this the request hangs for as long as
 * the browser allows: the promise never rejects, `withRetry` never runs, and
 * the seller watches a spinner that will never resolve — with no error, no
 * retry and no saved photo. That is precisely the failure ADR-0009 exists to
 * prevent, and retry alone cannot prevent it.
 *
 * Generous deliberately. A compressed photo is a few hundred kilobytes, so
 * thirty seconds already means a very poor connection; the job here is to
 * notice a connection that has died, not to police one that is merely slow.
 */
const UPLOAD_TIMEOUT_MS = 30_000;

async function withRetry<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!worthRetrying(error) || attempt >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
}

/** Uploads one file and returns its confirmed media id. A photo already compressed is sent as it is. */
export async function uploadMedia(kind: MediaKind, file: Blob, capture: Capture = {}, options: { compressed?: boolean } = {}): Promise<string> {
  const body = !options.compressed && (PHOTO_ONLY.has(kind) || file.type === 'image/jpeg') ? await compressPhoto(file) : file;

  const requestKey = crypto.randomUUID();
  const ticket = await withRetry(() => api<Ticket>('/media/uploads', {
    method: 'POST',
    idempotencyKey: requestKey,
    body: {
      kind, contentType: body.type, byteSize: body.size,
      ...(capture.capturedAt ? { capturedAt: capture.capturedAt.toISOString() } : {}),
      ...(capture.location ? { location: capture.location } : {}),
    },
  }));

  await withRetry(async () => {
    // A fresh signal per attempt: an aborted one stays aborted.
    const response = await fetch(ticket.upload.url, {
      method: 'PUT', headers: ticket.upload.headers, body, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    }).catch(() => { throw new ApiError(0, 'NETWORK_ERROR'); });
    if (!response.ok) throw new ApiError(response.status, 'UPLOAD_FAILED');
  });

  const confirmKey = crypto.randomUUID();
  await withRetry(() => api(`/media/${ticket.mediaId}/confirm`, { method: 'POST', idempotencyKey: confirmKey, body: {} }));
  return ticket.mediaId;
}
