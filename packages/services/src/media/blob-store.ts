/**
 * Object storage behind one interface (ARCHITECTURE §6.4, ADR-0020): Cloudflare
 * R2 in every environment, an in-memory implementation in automated tests.
 * The app never creates buckets.
 */
export type PresignedUpload = {
  readonly url: string;
  /** Headers the uploader must send exactly — the content type is part of the signature. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
};

export type BlobInfo = { readonly size: number; readonly contentType: string | null };

export interface BlobStore {
  /** A URL a browser can PUT one object to, pinned to one content type. */
  presignUpload(key: string, contentType: string, expiresInSeconds: number, now: Date): Promise<PresignedUpload>;
  /** A short-lived URL to read one object (SECURITY §5: 5 minutes for photos). */
  presignDownload(key: string, expiresInSeconds: number): Promise<string>;
  /** Size and type of a stored object, or null if absent. */
  head(key: string): Promise<BlobInfo | null>;
  /** The first bytes of an object — the magic-byte check (SECURITY §5). */
  readPrefix(key: string, bytes: number): Promise<Uint8Array>;
  /** A whole object, server-side — a delivery document to serve or attach; null if absent. */
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Server-side write, e.g. a generated delivery document. */
  put(key: string, body: Uint8Array<ArrayBuffer> | string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}
