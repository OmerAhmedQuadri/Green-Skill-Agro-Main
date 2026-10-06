import {
  BUSINESS_TIME_ZONE, businessDate, MEDIA_ABANDONED_AFTER_MS, MEDIA_KINDS, retentionOf, retentionScanBefore, STORED_KINDS,
  type MediaKind, type RetentionPeriod, type Settings, type StoredKind,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, isNotNull, isNull, lt, lte, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { writeAudit, type Executor } from '../platform';
import { defaultBranchId, getBlobStore, getDb } from '../runtime';
import { readSettings } from '../system';

const {
  mediaAssets, deliveryDocuments, stores, writeOffs, cashSettlements, dispatchOrders, payments, transferDecisions, attendanceSessions,
} = schema;

/**
 * Files whose record is still open are never deleted, whatever the period
 * (ADR-0049, SYS-012): a store awaiting approval, a write-off or settlement
 * awaiting a decision, a dispatch not yet delivered, a bank transfer not yet
 * confirmed, and an attendance session that is open, awaiting authorisation,
 * or flagged and not yet reviewed (ATT-012).
 */
const OPEN_FILES = sql`
  select ${stores.storefrontMediaId} from ${stores} where ${stores.status} = 'PENDING_APPROVAL'
  union all select ${writeOffs.photoId} from ${writeOffs} where ${writeOffs.status} = 'SUBMITTED'
  union all select ${cashSettlements.photoId} from ${cashSettlements} where ${cashSettlements.status} = 'SUBMITTED'
  union all select ${dispatchOrders.transportSlipMediaId} from ${dispatchOrders} where ${dispatchOrders.status} not in ('DELIVERED', 'CLOSED')
  union all select ${payments.voucherPhotoId} from ${payments} where ${payments.method} = 'BANK_TRANSFER'
    and not exists (select 1 from ${transferDecisions} where ${transferDecisions.paymentId} = ${payments.id})
  union all select unnest(array[
      ${attendanceSessions.checkInSelfieId}, ${attendanceSessions.checkInOdoPhotoId},
      ${attendanceSessions.checkOutSelfieId}, ${attendanceSessions.checkOutOdoPhotoId}])
    from ${attendanceSessions}
    where ${attendanceSessions.status} in ('OPEN', 'AWAITING_AUTHORISATION')
      or (cardinality(${attendanceSessions.checkInFlags}) + cardinality(${attendanceSessions.checkOutFlags}) > 0
        and ${attendanceSessions.reviewedAt} is null)`;

// Nulls filtered out: one null in the list would make `not in` true for nothing, and nothing would ever be deleted.
const IN_OPEN_RECORD = sql<boolean>`${mediaAssets.id} in (select open_files.id from (${OPEN_FILES}) as open_files(id) where open_files.id is not null)`;

/** Whether a file's record is still open. */
export async function isFileOpen(db: Executor, mediaId: string): Promise<boolean> {
  const [row] = await db.select({ open: IN_OPEN_RECORD }).from(mediaAssets).where(eq(mediaAssets.id, mediaId));
  return row?.open ?? false;
}

/** The stored day plus the period, in Riyadh time — Postgres clamps to the month's end exactly as core's `addMonths`. */
const dueBy = (storedAt: AnyColumn, months: number, today: string) =>
  sql`((${storedAt} at time zone ${BUSINESS_TIME_ZONE})::date + make_interval(months => ${months}::int))::date <= ${today}::date`;

/** Photos of one kind due on `today`: confirmed, not kept, past the period, and not part of an open record. */
function mediaDue(kind: MediaKind, months: number, today: string): SQL | undefined {
  return and(
    eq(mediaAssets.kind, kind), eq(mediaAssets.status, 'READY'), isNull(mediaAssets.keptAt),
    lt(mediaAssets.createdAt, retentionScanBefore(months, today)),
    dueBy(mediaAssets.createdAt, months, today),
    sql`not (${IN_OPEN_RECORD})`,
  );
}

/** Delivery documents due on `today`, counted from when they were printed. */
function documentsDue(months: number, today: string): SQL | undefined {
  return and(
    eq(deliveryDocuments.status, 'READY'), isNull(deliveryDocuments.purgedAt), isNull(deliveryDocuments.keptAt),
    isNotNull(deliveryDocuments.renderedAt),
    lt(deliveryDocuments.renderedAt, retentionScanBefore(months, today)),
    dueBy(deliveryDocuments.renderedAt, months, today),
  );
}

export type FileCount = { readonly files: number; readonly bytes: number };
const NONE: FileCount = { files: 0, bytes: 0 };

/** What a run on business day `today` would delete under `settings`, kind by kind. */
export async function dueOn(db: Executor, settings: Settings, today: string): Promise<Record<StoredKind, FileCount>> {
  const out = Object.fromEntries(STORED_KINDS.map((k) => [k, NONE])) as Record<StoredKind, FileCount>;
  const totals = (bytes: AnyColumn) => ({ files: sql<number>`count(*)`.mapWith(Number), bytes: sql<number>`coalesce(sum(${bytes}), 0)`.mapWith(Number) });
  for (const kind of STORED_KINDS) {
    const period: RetentionPeriod = retentionOf(settings, kind);
    if (period === 'FOREVER') continue;
    const [row] = kind === 'DELIVERY_DOCUMENT'
      ? await db.select(totals(deliveryDocuments.byteSize)).from(deliveryDocuments).where(documentsDue(period, today))
      : await db.select(totals(mediaAssets.byteSize)).from(mediaAssets).where(mediaDue(kind, period, today));
    out[kind] = row ?? NONE;
  }
  return out;
}

/**
 * The nightly run (worker job `media.retention`, 04:00 Riyadh — ADR-0049,
 * SYS-010): deletes the bytes of every file past its kind's period, keeping
 * the record, and removes uploads requested but never confirmed. Each file is
 * marked and deleted in one transaction, so a file kept forever a moment earlier
 * wins and a delete that fails leaves the file as it was. Idempotent.
 */
export async function purgeMedia(now: Date, batch = 500): Promise<{ expired: number; abandoned: number }> {
  const db = getDb();
  const store = getBlobStore();
  const settings = await readSettings(db);
  const today = businessDate(now);
  const deleted: Partial<Record<StoredKind, { files: number; bytes: number }>> = {};
  const tally = (kind: StoredKind, bytes: number | null) => {
    const k = (deleted[kind] ??= { files: 0, bytes: 0 });
    k.files += 1;
    k.bytes += bytes ?? 0;
  };

  for (const kind of MEDIA_KINDS) {
    const period = retentionOf(settings, kind);
    if (period === 'FOREVER') continue;
    for (;;) {
      const due = await db.select({ id: mediaAssets.id, storageKey: mediaAssets.storageKey, byteSize: mediaAssets.byteSize })
        .from(mediaAssets).where(mediaDue(kind, period, today)).limit(batch);
      for (const file of due) {
        const gone = await db.transaction(async (tx) => {
          const [marked] = await tx.update(mediaAssets).set({ status: 'PURGED', purgedAt: now })
            .where(and(eq(mediaAssets.id, file.id), eq(mediaAssets.status, 'READY'), isNull(mediaAssets.keptAt)))
            .returning({ id: mediaAssets.id });
          if (marked) await store.delete(file.storageKey);
          return marked !== undefined;
        });
        if (gone) tally(kind, file.byteSize);
      }
      if (due.length < batch) break;
    }
  }

  const documentPeriod = retentionOf(settings, 'DELIVERY_DOCUMENT');
  if (documentPeriod !== 'FOREVER') {
    for (;;) {
      const due = await db.select({ id: deliveryDocuments.id, storageKey: deliveryDocuments.storageKey, byteSize: deliveryDocuments.byteSize })
        .from(deliveryDocuments).where(documentsDue(documentPeriod, today)).limit(batch);
      for (const doc of due) {
        const gone = await db.transaction(async (tx) => {
          const [marked] = await tx.update(deliveryDocuments).set({ purgedAt: now })
            .where(and(eq(deliveryDocuments.id, doc.id), isNull(deliveryDocuments.purgedAt), isNull(deliveryDocuments.keptAt)))
            .returning({ id: deliveryDocuments.id });
          if (marked && doc.storageKey) await store.delete(doc.storageKey);
          return marked !== undefined;
        });
        if (gone) tally('DELIVERY_DOCUMENT', doc.byteSize);
      }
      if (due.length < batch) break;
    }
  }

  const stale = await db.select().from(mediaAssets)
    .where(and(eq(mediaAssets.status, 'PENDING'), lte(mediaAssets.createdAt, new Date(now.getTime() - MEDIA_ABANDONED_AFTER_MS)))).limit(batch);
  for (const asset of stale) {
    await store.delete(asset.storageKey);
    await db.update(mediaAssets).set({ status: 'PURGED', purgedAt: now }).where(eq(mediaAssets.id, asset.id));
  }

  const expired = Object.values(deleted).reduce((n, k) => n + k.files, 0);
  if (expired + stale.length > 0) {
    await writeAudit(db, { actorId: null, branchId: await defaultBranchId(), requestId: null, ip: null }, {
      action: 'media.purged', entityType: 'media', after: { expired, abandoned: stale.length, deleted },
    });
  }
  return { expired, abandoned: stale.length };
}
