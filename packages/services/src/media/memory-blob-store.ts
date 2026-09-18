import type { BlobInfo, BlobStore, PresignedUpload } from './blob-store';

type Stored = { body: Uint8Array; contentType: string };

/**
 * In-memory BlobStore for automated tests (TESTING §3): no network, no
 * credentials. `completeUpload` stands in for the browser's direct PUT.
 */
export function createMemoryBlobStore() {
  const objects = new Map<string, Stored>();
  const store: BlobStore = {
    presignUpload(key, contentType, expiresInSeconds, now): Promise<PresignedUpload> {
      return Promise.resolve({
        url: `memory://blob/${encodeURIComponent(key)}`,
        headers: { 'content-type': contentType },
        expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
      });
    },
    presignDownload: (key) => Promise.resolve(`memory://blob/${encodeURIComponent(key)}?download`),
    head(key): Promise<BlobInfo | null> {
      const object = objects.get(key);
      return Promise.resolve(object ? { size: object.body.byteLength, contentType: object.contentType } : null);
    },
    put(key, body, contentType) {
      objects.set(key, { body: typeof body === 'string' ? new TextEncoder().encode(body) : body, contentType });
      return Promise.resolve();
    },
    delete(key) {
      objects.delete(key);
      return Promise.resolve();
    },
  };
  return {
    ...store,
    completeUpload: (key: string, body: Uint8Array, contentType: string) => { objects.set(key, { body, contentType }); },
    keys: () => [...objects.keys()],
  };
}
