import type { PermissionCode } from '../identity';
import { businessMonth } from '../time';

/**
 * Every photograph and document the system stores (DATA-MODEL §5.8,
 * SECURITY §5). One policy row per kind: who may upload it, who may read it,
 * which file types are accepted, and how long it is kept.
 */
export const MEDIA_KINDS = [
  'SELFIE', 'ODOMETER', 'STOREFRONT', 'WRITE_OFF_EVIDENCE', 'DEPOSIT_SLIP', 'TRANSPORT_SLIP',
] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
/** Upload URLs are short-lived; a phone on a slow network still has ample time. */
export const MEDIA_UPLOAD_URL_SECONDS = 10 * 60;
/** SECURITY §5: photos are read through 5-minute signed URLs. */
export const MEDIA_DOWNLOAD_URL_SECONDS = 5 * 60;
/** A requested upload never confirmed within this window is abandoned and removed. */
export const MEDIA_ABANDONED_AFTER_MS = 24 * 3_600_000;

type Policy = {
  /** Required to upload this kind. */
  readonly upload: PermissionCode;
  /** Any one of these lets someone other than the uploader read it. */
  readonly read: readonly PermissionCode[];
  readonly contentTypes: readonly string[];
  /** Live in-app camera only — no gallery — so an old photo can't pass as today's (ARCHITECTURE §6.4). */
  readonly liveCameraOnly: boolean;
  /** OQ-009: staff photographs are purged after the Admin's retention period (`media.photo_retention_days`); evidence is kept. */
  readonly purged: boolean;
  /** Object-key prefix, so a bucket lifecycle rule can target a kind (ADR-0020). */
  readonly prefix: string;
};

const PHOTO = ['image/jpeg'] as const;
const PHOTO_OR_DOCUMENT = ['image/jpeg', 'image/png', 'application/pdf'] as const;

export const MEDIA_POLICY: Readonly<Record<MediaKind, Policy>> = {
  SELFIE:             { upload: 'attendance.self', read: ['attendance.view', 'attendance.manage'], contentTypes: PHOTO, liveCameraOnly: true, purged: true, prefix: 'selfie' },
  ODOMETER:           { upload: 'attendance.self', read: ['attendance.view', 'attendance.manage'], contentTypes: PHOTO, liveCameraOnly: true, purged: true, prefix: 'odometer' },
  STOREFRONT:         { upload: 'stores.onboard', read: ['stores.view_all', 'stores.approve'], contentTypes: PHOTO, liveCameraOnly: false, purged: false, prefix: 'storefront' },
  WRITE_OFF_EVIDENCE: { upload: 'inventory.submit_write_off', read: ['inventory.approve_write_off'], contentTypes: PHOTO, liveCameraOnly: false, purged: false, prefix: 'write-off' },
  // A bank confirmation is often a screenshot or a PDF (ARCHITECTURE §6.4).
  DEPOSIT_SLIP:       { upload: 'cash.submit_settlement', read: ['cash.approve_settlement', 'cash.view_cash_in_hand'], contentTypes: PHOTO_OR_DOCUMENT, liveCameraOnly: false, purged: false, prefix: 'deposit-slip' },
  TRANSPORT_SLIP:     { upload: 'sales.fulfil_dispatch', read: ['sales.fulfil_dispatch', 'sales.view_all'], contentTypes: PHOTO_OR_DOCUMENT, liveCameraOnly: false, purged: false, prefix: 'transport-slip' },
};

export function isMediaKind(value: string): value is MediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(value);
}

/** The uploader may always read their own file; anyone else needs a read permission for the kind. */
export function canReadMedia(kind: MediaKind, permissions: ReadonlySet<PermissionCode>, isUploader: boolean): boolean {
  return isUploader || MEDIA_POLICY[kind].read.some((p) => permissions.has(p));
}

const EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

/** `selfie/2026-09/<id>.jpg` — kind first, for lifecycle rules; month second, for browsing. */
export function mediaStorageKey(kind: MediaKind, id: string, contentType: string, now: Date): string {
  return `${MEDIA_POLICY[kind].prefix}/${businessMonth(now)}/${id}.${EXTENSION[contentType] ?? 'bin'}`;
}

/**
 * The real type from a file's first bytes (SECURITY §5 — magic bytes). A client
 * can declare anything; this is what the server believes.
 */
export function sniffContentType(head: Uint8Array): string | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf'; // %PDF-
  return null;
}

/** OQ-009: a purged kind older than the retention period, in whole days. */
export function isPastRetention(kind: MediaKind, createdAt: Date, now: Date, retentionDays: number): boolean {
  return MEDIA_POLICY[kind].purged && now.getTime() - createdAt.getTime() >= retentionDays * 86_400_000;
}
