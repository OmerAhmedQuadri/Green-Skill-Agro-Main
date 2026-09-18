import { AwsClient } from 'aws4fetch';
import type { BlobInfo, BlobStore, PresignedUpload } from './blob-store';

export type S3Settings = {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

/**
 * S3-API implementation, used with Cloudflare R2 (ADR-0020). aws4fetch only
 * signs requests (SigV4) — no SDK defaults such as automatic request checksums,
 * which have been incompatible with R2. Path-style URLs.
 */
export function createS3BlobStore(settings: S3Settings): BlobStore {
  const client = new AwsClient({
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    service: 's3',
    region: settings.region,
  });
  const base = settings.endpoint.replace(/\/+$/, '');
  const objectUrl = (key: string) => `${base}/${settings.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

  const presign = async (key: string, method: 'GET' | 'PUT', expiresInSeconds: number, headers: Record<string, string> = {}) => {
    const url = new URL(objectUrl(key));
    url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));
    // aws4fetch leaves content-type out of the signature by default; allHeaders
    // signs it, so an upload URL accepts only the declared type (SECURITY §5).
    const signed = await client.sign(new Request(url, { method, headers }), { aws: { signQuery: true, allHeaders: true } });
    return signed.url;
  };

  const ensureStatus = (response: Response, operation: string, ok: (status: number) => boolean): void => {
    if (!ok(response.status)) {
      // Never include URLs or bodies: signed URLs carry credentials.
      throw new Error(`object storage ${operation} failed with HTTP ${response.status}`);
    }
  };

  return {
    async presignUpload(key, contentType, expiresInSeconds, now): Promise<PresignedUpload> {
      const headers = { 'content-type': contentType };
      return {
        url: await presign(key, 'PUT', expiresInSeconds, headers),
        headers,
        expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
      };
    },

    presignDownload: (key, expiresInSeconds) => presign(key, 'GET', expiresInSeconds),

    async head(key): Promise<BlobInfo | null> {
      const response = await client.fetch(objectUrl(key), { method: 'HEAD' });
      if (response.status === 404) return null;
      ensureStatus(response, 'HEAD', (s) => s === 200);
      return { size: Number(response.headers.get('content-length') ?? 0), contentType: response.headers.get('content-type') };
    },

    async put(key, body, contentType) {
      const response = await client.fetch(objectUrl(key), { method: 'PUT', body, headers: { 'content-type': contentType } });
      ensureStatus(response, 'PUT', (s) => s === 200);
    },

    async delete(key) {
      const response = await client.fetch(objectUrl(key), { method: 'DELETE' });
      ensureStatus(response, 'DELETE', (s) => s === 204 || s === 200 || s === 404);
    },
  };
}
