import { z } from 'zod';

/** Media API contracts (API.md — Reports and media; ARCHITECTURE §6.4). */
/** Mirror `MEDIA_KINDS` in packages/core/src/media — a services test holds the two together. */
export const MediaKind = z.enum(['SELFIE', 'ODOMETER', 'STOREFRONT', 'WRITE_OFF_EVIDENCE', 'DEPOSIT_SLIP', 'TRANSPORT_SLIP', 'PAYMENT_VOUCHER']);

export const RequestUpload = z.object({
  kind: MediaKind,
  contentType: z.string().min(3).max(100),
  byteSize: z.number().int().positive(),
  capturedAt: z.iso.datetime().optional(),
  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).max(100_000).optional(),
  }).optional(),
});

export const UploadTicket = z.object({
  mediaId: z.uuid(),
  upload: z.object({ url: z.url(), headers: z.record(z.string(), z.string()), expiresAt: z.string() }),
});

export const MediaSummary = z.object({
  id: z.uuid(), kind: MediaKind, status: z.enum(['PENDING', 'READY', 'REJECTED', 'PURGED']),
  contentType: z.string(), byteSize: z.number().int().nullable(),
});

/** ADR-0049: what the storage policy governs — the photo kinds and the delivery documents. Mirrors `STORED_KINDS` in core. */
export const StoredKind = z.enum([...MediaKind.options, 'DELIVERY_DOCUMENT']);

/** Whole months, or forever. The settings register in core checks each kind's range. */
export const RetentionPeriod = z.union([z.literal('FOREVER'), z.number().int()]);

/** SYS-010, SYS-012: new periods, a new budget, or both — `confirm` once the Super Admin has seen what the next run deletes. */
export const SetStoragePolicyRequest = z.object({
  periods: z.partialRecord(StoredKind, RetentionPeriod).optional(),
  budgetGb: z.number().int().optional(),
  confirm: z.boolean().optional(),
});

/** The proposed periods, from the address: `?SELFIE=1&STOREFRONT=FOREVER`. */
export const PreviewStoragePolicyQuery = z.partialRecord(StoredKind, z.union([z.literal('FOREVER'), z.coerce.number().int()]));

/** SYS-011: keep one file forever, or hand it back to the policy. */
export const KeepFileRequest = z.object({ keep: z.boolean() });
