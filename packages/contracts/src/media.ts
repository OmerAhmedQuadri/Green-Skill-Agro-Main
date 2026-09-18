import { z } from 'zod';

/** Media API contracts (API.md — Reports and media; ARCHITECTURE §6.4). */
export const MediaKind = z.enum(['SELFIE', 'ODOMETER', 'STOREFRONT', 'WRITE_OFF_EVIDENCE', 'DEPOSIT_SLIP', 'TRANSPORT_SLIP']);

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
