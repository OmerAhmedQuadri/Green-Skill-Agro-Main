import {
  addMonths, businessDate, businessDayStart, retentionDueOn, retentionOf, STORED_KINDS, type DomainError, type PermissionCode,
} from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { blobs } from '../../test/blobs';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { aPhoto, JPEG } from '../../test/media';
import { aPdfRenderer, aSellingSeller, paid } from '../../test/sales';
import { okraInWarehouse } from '../../test/stock';
import { aStore } from '../../test/stores';
import { decideWriteOffRequest, getSkuStock, submitWriteOff } from '../inventory';
import { writeAudit } from '../platform';
import { defaultBranchId, getDb } from '../runtime';
import { deliveryDocumentPdf, getSale, keepDeliveryDocument, recordSale, renderPendingDocuments } from '../sales';
import { decideTransfer } from '../stores';
import { getSettings, readSettings, updateSettings } from '../system';
import { purgeMedia } from './retention';
import { fileDetails, keepFile, previewStoragePolicy, setStoragePolicy, storageOverview } from './storage';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const code = (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: DomainError) => ({ code: e.code, ...e.details }));
const as = async (role: 'SUPER_ADMIN' | 'ADMIN' | 'SELLER', now?: Date) => ctxFor(await anAccount(role), now ? { now } : {});

/** The nightly run — 04:00 Riyadh — on a business day. */
const runOn = (day: string) => new Date(businessDayStart(day).getTime() + 4 * HOUR);
const dayBefore = (day: string) => businessDate(new Date(businessDayStart(day).getTime() - 12 * HOUR));
const row = async (id: string) =>
  (await ownerQuery<{ status: string; created_at: Date }>('select status, created_at from media_assets where id = $1', [id]))[0];
const statusOf = async (id: string) => (await row(id))?.status;
/** The Riyadh day a file was stored — read back, so a test that crosses midnight still counts from the right day. */
const storedOn = async (id: string) => businessDate((await row(id))?.created_at ?? new Date(0));

describe('storage management (ADR-0049)', () => {
  it('SYS-010: each kind goes on its own day — selfies and odometer photos at 3 months, write-offs and transport slips at 6, the rest never', async () => {
    const seller = await as('SELLER');
    const admin = await as('ADMIN');
    const files = {
      SELFIE: await aPhoto(seller, 'SELFIE'), ODOMETER: await aPhoto(seller, 'ODOMETER'), STOREFRONT: await aPhoto(seller, 'STOREFRONT'),
      WRITE_OFF_EVIDENCE: await aPhoto(seller, 'WRITE_OFF_EVIDENCE'), DEPOSIT_SLIP: await aPhoto(seller, 'DEPOSIT_SLIP'),
      TRANSPORT_SLIP: await aPhoto(admin, 'TRANSPORT_SLIP'), PAYMENT_VOUCHER: await aPhoto(seller, 'PAYMENT_VOUCHER'),
    };
    const left = async () => Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k, id]): Promise<[string, string | undefined]> => [k, await statusOf(id)])));
    const day = await storedOn(files.SELFIE);

    expect(await purgeMedia(runOn(dayBefore(addMonths(day, 3))))).toEqual({ expired: 0, abandoned: 0 });
    expect(await purgeMedia(runOn(addMonths(day, 3)))).toEqual({ expired: 2, abandoned: 0 });
    expect(await left()).toMatchObject({ SELFIE: 'PURGED', ODOMETER: 'PURGED', WRITE_OFF_EVIDENCE: 'READY', TRANSPORT_SLIP: 'READY' });
    expect(await purgeMedia(runOn(addMonths(day, 6)))).toEqual({ expired: 2, abandoned: 0 });
    expect(await purgeMedia(runOn(addMonths(day, 240)))).toEqual({ expired: 0, abandoned: 0 });
    expect(await left()).toEqual({
      SELFIE: 'PURGED', ODOMETER: 'PURGED', STOREFRONT: 'READY', WRITE_OFF_EVIDENCE: 'PURGED',
      DEPOSIT_SLIP: 'READY', TRANSPORT_SLIP: 'PURGED', PAYMENT_VOUCHER: 'READY',
    });
    // The bytes are gone from storage; the records stay. Every run that deleted something says what, kind by kind.
    expect(blobs.keys()).toHaveLength(3);
    const [run] = await ownerQuery<{ after: { deleted: unknown } }>(`select after from audit_log where action = 'media.purged' order by occurred_at desc limit 1`);
    expect(run?.after.deleted).toEqual({ WRITE_OFF_EVIDENCE: { files: 1, bytes: JPEG.byteLength }, TRANSPORT_SLIP: { files: 1, bytes: JPEG.byteLength } });
  });

  it('SYS-010: a month is a calendar month — a selfie from 31 January kept a month goes on 28 February', async () => {
    await setStoragePolicy(await as('SUPER_ADMIN'), { periods: { SELFIE: 1 } });
    const taken = new Date('2027-01-31T09:00:00+03:00');
    const selfie = await aPhoto(await as('SELLER', taken), 'SELFIE');
    expect(retentionDueOn(taken, 1)).toBe('2027-02-28');
    expect(await purgeMedia(runOn('2027-02-27'))).toEqual({ expired: 0, abandoned: 0 });
    expect(await purgeMedia(runOn('2027-02-28'))).toEqual({ expired: 1, abandoned: 0 });
    expect(await statusOf(selfie)).toBe('PURGED');
  });

  it('SYS-012: a file whose record is still open outlives its period, and goes at the first run after the record closes', async () => {
    const admin = await as('ADMIN');
    await setStoragePolicy(await as('SUPER_ADMIN'), { periods: { PAYMENT_VOUCHER: 1, STOREFRONT: 1 } });

    // A write-off awaiting a decision.
    const stock = await okraInWarehouse(admin);
    const [batch] = (await getSkuStock(admin, stock.bag.id)).batches;
    const photoId = await aPhoto(admin, 'WRITE_OFF_EVIDENCE');
    const report = await submitWriteOff(admin, { batchId: batch?.batchId ?? '', packs: 1, reason: 'DAMAGED', note: 'Torn bag', photoId });
    // A seller checked in for the day — the session is open — whose store paid by bank transfer, not yet confirmed.
    const setup = await aSellingSeller(admin, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    const sale = await recordSale(setup.seller.ctx, {
      storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 1 }], payment: await paid(setup.seller.ctx, '90.00', 'BANK_TRANSFER', 'TRX-1'),
    });
    const voucher = sale.payment?.voucher?.photoId ?? '';
    const [session] = await ownerQuery<{ check_in_selfie_id: string }>(
      'select check_in_selfie_id from attendance_sessions where seller_id = $1', [setup.seller.account.id],
    );
    const selfie = session?.check_in_selfie_id ?? '';
    // And a store still awaiting approval.
    const pending = await aStore(setup.seller.ctx);
    const storefront = pending.storefrontMediaId ?? '';

    expect(await fileDetails(admin, photoId)).toMatchObject({ open: true, deletesOn: addMonths(await storedOn(photoId), 6) });
    const day = await storedOn(photoId);
    const due = runOn(addMonths(day, 6));
    // Only the approved store's storefront goes; every file whose record is open stays.
    expect(await purgeMedia(due)).toEqual({ expired: 1, abandoned: 0 });
    expect(await statusOf(setup.store.storefrontMediaId ?? '')).toBe('PURGED');
    for (const id of [photoId, voucher, selfie, storefront]) expect(await statusOf(id)).toBe('READY');

    const other = await as('ADMIN');
    await decideWriteOffRequest(other, report.id, { version: report.version, approve: false, comment: 'Not damaged after all' });
    await decideTransfer(other, sale.payment?.id ?? '', { outcome: 'CONFIRMED' });
    expect(await fileDetails(admin, photoId)).toMatchObject({ open: false });

    // What the page says the next run deletes is exactly what it deletes.
    const next = runOn(businessDate(new Date(due.getTime() + DAY)));
    const preview = await previewStoragePolicy(await as('SUPER_ADMIN', new Date(next.getTime() - HOUR)), {});
    expect(preview.runAt).toEqual(next);
    expect(preview.due).toMatchObject({
      WRITE_OFF_EVIDENCE: { files: 1, bytes: JPEG.byteLength }, PAYMENT_VOUCHER: { files: 1, bytes: JPEG.byteLength },
      SELFIE: { files: 0 }, STOREFRONT: { files: 0 },
    });
    expect(await purgeMedia(next)).toEqual({ expired: 2, abandoned: 0 });
    expect(await statusOf(photoId)).toBe('PURGED');
    expect(await statusOf(voucher)).toBe('PURGED');
    // The seller has not checked out, and the store is still waiting: both stay.
    expect(await statusOf(selfie)).toBe('READY');
    expect(await statusOf(storefront)).toBe('READY');
  });

  it('SYS-011: a file kept forever outlives its period; handed back to the policy, it goes at the next run', async () => {
    const seller = await as('SELLER');
    const admin = await as('ADMIN');
    const selfie = await aPhoto(seller, 'SELFIE');
    const day = await storedOn(selfie);

    const kept = await keepFile(admin, selfie, true);
    expect(kept).toMatchObject({ status: 'READY', kind: 'SELFIE', period: 3, deletesOn: null, canKeep: true });
    expect(kept.kept?.by).toBeTruthy();
    expect(await code(keepFile(seller, selfie, true))).toBe('FORBIDDEN');
    const viewer = await ctxFor(await anAccount('MANAGER'), { overrides: new Map<PermissionCode, boolean>([['attendance.view', true]]) });
    expect(await code(keepFile(viewer, selfie, true))).toBe('FORBIDDEN');
    expect(await fileDetails(viewer, selfie)).toMatchObject({ canKeep: false });
    expect(await code(fileDetails(await as('SELLER'), selfie))).toBe('NOT_FOUND');

    const run = runOn(addMonths(day, 3));
    expect((await previewStoragePolicy(await as('SUPER_ADMIN', new Date(run.getTime() - HOUR)), {})).due.SELFIE).toEqual({ files: 0, bytes: 0 });
    expect(await purgeMedia(run)).toEqual({ expired: 0, abandoned: 0 });
    expect(await keepFile(admin, selfie, false)).toMatchObject({ kept: null, deletesOn: addMonths(day, 3) });
    expect(await purgeMedia(runOn(addMonths(day, 4)))).toEqual({ expired: 1, abandoned: 0 });

    // A link to it still explains itself, to whoever could see it.
    expect(await fileDetails(admin, selfie)).toMatchObject({ status: 'PURGED', purgedAt: runOn(addMonths(day, 4)), deletesOn: null, canKeep: false });
    expect(await code(keepFile(admin, selfie, true))).toBe('FILE_DELETED');
    const actions = await ownerQuery<{ action: string }>(`select action from audit_log where entity_id = $1 order by occurred_at`, [selfie]);
    expect(actions.map((a) => a.action)).toEqual(['media.kept', 'media.released']);
  });

  it('SYS-012: a shorter period that deletes files is refused until confirmed, and says how much; a longer one is not', async () => {
    const sa = await as('SUPER_ADMIN');
    await aPhoto(await as('SELLER', new Date(Date.now() - 62 * DAY)), 'SELFIE');

    expect((await previewStoragePolicy(sa, { periods: { SELFIE: 1 } })).due.SELFIE).toEqual({ files: 1, bytes: JPEG.byteLength });
    expect(await refusal(setStoragePolicy(sa, { periods: { SELFIE: 1 } }))).toEqual({ code: 'STORAGE_CONFIRM_DELETES', files: 1, bytes: JPEG.byteLength });
    expect(retentionOf(await readSettings(), 'SELFIE')).toBe(3);

    const saved = await setStoragePolicy(sa, { periods: { SELFIE: 1 }, confirm: true });
    expect(saved.kinds.find((k) => k.kind === 'SELFIE')).toMatchObject({ period: 1, due: { files: 1, bytes: JPEG.byteLength } });
    await setStoragePolicy(sa, { periods: { SELFIE: 12 }, budgetGb: 25 });
    const [change] = await ownerQuery<{ before: unknown; after: unknown }>(
      `select before, after from audit_log where action = 'system.settings_changed' order by occurred_at desc limit 1`,
    );
    expect(change).toEqual({ before: { 'storage.keep_selfie': 1, 'storage.budget_gb': 10 }, after: { 'storage.keep_selfie': 12, 'storage.budget_gb': 25 } });

    // The Super Admin's alone, and only here — not through the general settings.
    const admin = await as('ADMIN');
    expect(await code(setStoragePolicy(admin, { periods: { SELFIE: 2 } }))).toBe('FORBIDDEN');
    expect(await code(previewStoragePolicy(admin, {}))).toBe('FORBIDDEN');
    expect(await code(updateSettings(sa, [{ key: 'storage.keep_selfie', value: 2 }]))).toBe('INVALID_SETTING');
    expect((await getSettings(sa)).editable.filter((k) => k.startsWith('storage.'))).toEqual([]);
    expect(await code(setStoragePolicy(sa, { periods: { NOT_A_KIND: 2 } }))).toBe('INVALID_SETTING');
    expect(await code(setStoragePolicy(sa, {}))).toBe('INVALID_SETTING');
  });

  it('SYS-013: each kind — stored, added in 30 days, oldest, kept, deleted, due — against the budget, with the database, disk and backups', async () => {
    const sa = await as('SUPER_ADMIN');
    const earlier = new Date(Date.now() - 40 * DAY);
    await aPhoto(await as('SELLER'), 'SELFIE');
    const kept = await aPhoto(await as('SELLER', earlier), 'SELFIE');
    await aPhoto(await as('SELLER', new Date(Date.now() - 200 * DAY)), 'SELFIE');
    await aPhoto(await as('SELLER'), 'STOREFRONT');
    expect(await purgeMedia(new Date())).toEqual({ expired: 1, abandoned: 0 });
    await keepFile(await as('ADMIN'), kept, true);

    const view = await storageOverview(sa);
    expect(view.kinds.map((k) => k.kind)).toEqual([...STORED_KINDS]);
    expect(view.kinds.find((k) => k.kind === 'SELFIE')).toEqual({
      kind: 'SELFIE', period: 3, files: 2, bytes: 2 * JPEG.byteLength, added: { files: 1, bytes: JPEG.byteLength },
      oldest: earlier, kept: 1, deleted: { files: 1, bytes: JPEG.byteLength }, due: { files: 0, bytes: 0 },
    });
    expect(view.kinds.find((k) => k.kind === 'STOREFRONT')).toMatchObject({ period: 'FOREVER', files: 1, deleted: { files: 0 } });
    expect(view.total).toEqual({ files: 3, bytes: 3 * JPEG.byteLength });
    expect([view.budgetGb, view.budgetBytes]).toEqual([10, 10_000_000_000]);
    expect(view.database.bytes).toBeGreaterThan(0);
    expect(view.disk?.freeBytes).toBeLessThanOrEqual(view.disk?.totalBytes ?? 0);
    expect(view.backups).toBeNull();

    // The nightly backup reports what the bucket holds; the page shows its latest word.
    await writeAudit(getDb(), { actorId: null, branchId: await defaultBranchId(), requestId: 'backup', ip: null }, {
      action: 'backup.completed', entityType: 'backup', entityId: 'gsa-20261006T000000Z.dump',
      after: { count: 30, bytes: 123_456_789, newest: '2026-10-06T00:00:01.000Z' },
    });
    expect((await storageOverview(sa)).backups).toMatchObject({ count: 30, bytes: 123_456_789, newestAt: new Date('2026-10-06T00:00:01.000Z') });
    expect(await code(storageOverview(await as('ADMIN')))).toBe('FORBIDDEN');
  });

  it('SYS-010, DOC-005: delivery documents are kept forever by default; given a period they go — the sale says when — and a kept one stays', async () => {
    const admin = await as('ADMIN');
    const setup = await aSellingSeller(admin);
    const first = await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 1 }] });
    const second = await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 1 }] });
    expect(await renderPendingDocuments(aPdfRenderer(), new Date())).toEqual({ rendered: 2, failed: 0 });
    const printed = businessDate(new Date());

    expect(await purgeMedia(runOn(addMonths(printed, 120)))).toEqual({ expired: 0, abandoned: 0 });
    await keepDeliveryDocument(admin, second.id, true);
    expect(await code(keepDeliveryDocument(setup.seller.ctx, second.id, true))).toBe('FORBIDDEN');

    await setStoragePolicy(await as('SUPER_ADMIN'), { periods: { DELIVERY_DOCUMENT: 18 } });
    expect(await purgeMedia(runOn(dayBefore(addMonths(printed, 18))))).toEqual({ expired: 0, abandoned: 0 });
    expect(await purgeMedia(runOn(addMonths(printed, 18)))).toEqual({ expired: 1, abandoned: 0 });

    expect((await getSale(admin, first.id)).document).toMatchObject({ status: 'READY', purgedAt: runOn(addMonths(printed, 18)), kept: false });
    expect(await code(deliveryDocumentPdf(admin, first.id))).toBe('FILE_DELETED');
    expect(await code(keepDeliveryDocument(admin, first.id, true))).toBe('FILE_DELETED');
    expect((await deliveryDocumentPdf(admin, second.id)).pdf.byteLength).toBeGreaterThan(0);
    expect((await getSale(admin, second.id)).document).toMatchObject({ purgedAt: null, kept: true });
  });
});
