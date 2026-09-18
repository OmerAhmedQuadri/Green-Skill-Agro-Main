import { index, integer, numeric, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './identity';
import { branches } from './organisation';

export const mediaKind = pgEnum('media_kind', [
  'SELFIE', 'ODOMETER', 'STOREFRONT', 'WRITE_OFF_EVIDENCE', 'DEPOSIT_SLIP', 'TRANSPORT_SLIP',
]);

/**
 * PENDING  — upload URL issued, not yet confirmed
 * READY    — confirmed: exists, right owner, size and real type checked
 * REJECTED — failed confirmation; the object was deleted
 * PURGED   — removed by retention (OQ-009) or abandoned; the row stays as a record
 */
export const mediaStatus = pgEnum('media_status', ['PENDING', 'READY', 'REJECTED', 'PURGED']);

/** Every photograph and document (DATA-MODEL §5.8). The bytes live in R2 (ADR-0020). */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: id(),
    kind: mediaKind('kind').notNull(),
    status: mediaStatus('status').notNull().default('PENDING'),
    storageKey: text('storage_key').notNull().unique(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size'), // known once confirmed
    capturedAt: timestamptz('captured_at'),
    capturedLat: numeric('captured_lat', { precision: 9, scale: 6 }),
    capturedLng: numeric('captured_lng', { precision: 9, scale: 6 }),
    captureAccuracyM: numeric('capture_accuracy_m', { precision: 8, scale: 1 }),
    uploadedBy: uuid('uploaded_by').notNull().references(() => users.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    createdAt: createdAt(),
    confirmedAt: timestamptz('confirmed_at'),
    purgedAt: timestamptz('purged_at'),
  },
  (t) => [
    index('media_assets_uploaded_by_idx').on(t.uploadedBy),
    // The retention and abandoned-upload sweeps scan by status and age.
    index('media_assets_status_created_at_idx').on(t.status, t.createdAt),
  ],
);
