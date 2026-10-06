import { businessDate, nextBusinessDate, type NotificationKind, type PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { anAccount, ctxFor } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { aSellingSeller, paid } from '../../test/sales';
import { aStore, basePriceListId } from '../../test/stores';
import { aLoadedVehicle, aSeller, AWAY, aVehicle, captureFor, checkInAs, YARD } from '../../test/vehicles';
import { authoriseZone, checkOut, closeFinishedDays, createZone, openDayOnBehalf } from '../attendance';
import { decideSettlement, submitSettlement } from '../cash';
import type { Ctx } from '../context';
import { cancelOrder, decideLostClaim, raiseDispatchOrder, raiseLostClaim, releaseOrder, releaseOrderBack, takeOrder } from '../dispatch';
import { submitWriteOff } from '../inventory';
import { setPriceListItems } from '../pricing';
import { decideDiscountRequest, expireDiscountRequests, recordSale, withdrawSale } from '../sales';
import { decideStore, decideTransfer } from '../stores';
import { updateToggles } from '../system';
import { assignVehicle, declareClosingStock, reviewClosingStock } from '../vehicles';
import { listMyNotifications, markNotificationsRead, waitingForDecision } from './index';

const admin = async () => ctxFor(await anAccount('ADMIN'));
const manager = async (grants: PermissionCode[]) => ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });
const HOUR = 3_600_000;
/** A reader's copies of one kind, newest first, with how each ended. */
const copies = async (ctx: Ctx, kind: NotificationKind) => (await listMyNotifications(ctx, { limit: 50 })).items.filter((n) => n.kind === kind);
const unread = async (ctx: Ctx) => (await listMyNotifications(ctx)).unread;
const outcomes = async (ctx: Ctx, kind: NotificationKind) => (await copies(ctx, kind)).map((n) => n.resolution?.outcome ?? null);
const waiting = async (ctx: Ctx) => Object.fromEntries((await waitingForDecision(ctx)).map((q) => [q.queue, q.count]));

describe('a request sent to many ends for all of them (ADR-0051)', () => {
  it('SYS-014: a store approved by one approver is approved on every approver\'s bell, and stops counting', async () => {
    const [first, second] = [await admin(), await admin()];
    const seller = await aSeller();
    const store = await aStore(seller.ctx);
    expect(await copies(second, 'STORE_PENDING_APPROVAL')).toMatchObject([{ read: false, resolution: null }]);
    expect(await unread(second)).toBe(1);

    await decideStore(first, store.id, 'approve', { version: store.version });
    expect(await copies(second, 'STORE_PENDING_APPROVAL')).toMatchObject([{ read: false, resolution: { outcome: 'APPROVED', by: { id: first.user.id } } }]);
    expect((await copies(second, 'STORE_PENDING_APPROVAL'))[0]?.resolution?.by?.name).toMatch(/^ADMIN \d+$/);
    expect(await unread(second)).toBe(0);
    expect((await copies(second, 'STORE_PENDING_APPROVAL'))[0]?.resolution?.byYou).toBe(false);
    // Whoever decided has their own copy end too, though they acted from the page.
    expect(await copies(first, 'STORE_PENDING_APPROVAL')).toMatchObject([{ resolution: { outcome: 'APPROVED', by: { id: first.user.id }, byYou: true } }]);
    // News is not a request: what the seller was told never ends.
    expect(await copies(seller.ctx, 'STORE_APPROVED')).toMatchObject([{ resolution: null }]);

    // Each copy is about its own store: deciding one leaves the next waiting.
    const [a, b] = [await aStore(seller.ctx), await aStore(seller.ctx)];
    await decideStore(second, a.id, 'reject', { version: a.version, reason: 'Duplicate' });
    expect(await outcomes(first, 'STORE_PENDING_APPROVAL')).toEqual([null, 'REJECTED', 'APPROVED']);
    expect(b.status).toBe('PENDING_APPROVAL');
  });

  it('SYS-014: a discount request ends when decided, withdrawn, or expired — by its time, or at check-out', async () => {
    const ctx = await admin();
    const other = await admin();
    const { seller, store, bag } = await aSellingSeller(ctx);
    const ask = () => recordSale(seller.ctx, { storeId: store.id, lines: [{ skuId: bag.id, packs: 1, discount: '12' }], approvalReason: 'Competitor' });

    const reduced = await ask();
    const lineId = reduced.lines[0]?.id ?? '';
    await decideDiscountRequest(ctx, reduced.id, { version: reduced.version, approve: true, lines: [{ lineId, discount: '8' }], comment: 'Eight at most' });
    expect((await copies(other, 'DISCOUNT_APPROVAL_REQUESTED'))[0]).toMatchObject({ resolution: { outcome: 'REDUCED', by: { id: ctx.user.id } } });
    // The approved sale lapses unfinished on a later day; its request was decided, and stays so.
    expect((await expireDiscountRequests(new Date(Date.now() + 26 * HOUR))).expired).toBe(1);
    expect((await copies(other, 'DISCOUNT_APPROVAL_REQUESTED'))[0]?.resolution?.outcome).toBe('REDUCED');

    const withdrawn = await ask();
    await withdrawSale(seller.ctx, withdrawn.id, { version: withdrawn.version });
    expect((await copies(other, 'DISCOUNT_APPROVAL_REQUESTED'))[0]).toMatchObject({ resolution: { outcome: 'WITHDRAWN', by: { id: seller.account.id } } });

    await ask();
    expect(await expireDiscountRequests(new Date(Date.now() + 2 * HOUR))).toEqual({ expired: 1 });
    expect((await copies(other, 'DISCOUNT_APPROVAL_REQUESTED'))[0]).toMatchObject({ resolution: { outcome: 'EXPIRED', by: null } });

    await ask();
    await checkOut(seller.ctx, await captureFor(seller.ctx, 10_050));
    expect((await copies(other, 'DISCOUNT_APPROVAL_REQUESTED'))[0]?.resolution?.outcome).toBe('EXPIRED');
    expect(await unread(other)).toBe(0);
  });

  it('SYS-014: a cash settlement ends for every approver; a handover, for the manager it was handed to', async () => {
    const ctx = await admin();
    const other = await admin();
    const setup = await aSellingSeller(ctx, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 2 }], payment: await paid(setup.seller.ctx, '180.00') });
    const deposit = await submitSettlement(setup.seller.ctx, { route: 'BANK_DEPOSIT', amount: '90.00', depositedOn: '2026-09-20', photoId: await aPhoto(setup.seller.ctx, 'DEPOSIT_SLIP') });
    await decideSettlement(ctx, deposit.id, { version: deposit.version, approve: true });
    expect(await copies(other, 'SETTLEMENT_SUBMITTED')).toMatchObject([{ resolution: { outcome: 'APPROVED', by: { id: ctx.user.id } } }]);

    const handover = await submitSettlement(setup.seller.ctx, {
      route: 'MANAGER_HANDOVER', amount: '90.00', receivedById: other.user.id, photoId: await aPhoto(setup.seller.ctx, 'DEPOSIT_SLIP'),
    });
    await decideSettlement(other, handover.id, { version: handover.version, approve: false, comment: 'Counted 80, not 90' });
    expect(await outcomes(other, 'SETTLEMENT_SUBMITTED')).toEqual(['REJECTED', 'APPROVED']);
  });

  it('SYS-014: a bank transfer ends for every approver once one confirms it arrived', async () => {
    const ctx = await admin();
    const other = await admin();
    const setup = await aSellingSeller(ctx, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    const sale = await recordSale(setup.seller.ctx, {
      storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 1 }], payment: await paid(setup.seller.ctx, '90.00', 'BANK_TRANSFER', 'TRX-4471'),
    });
    expect(await copies(other, 'TRANSFER_RECORDED')).toMatchObject([{ resolution: null }]);
    await decideTransfer(ctx, sale.payment?.id ?? '', { outcome: 'CONFIRMED' });
    expect(await copies(other, 'TRANSFER_RECORDED')).toMatchObject([{ resolution: { outcome: 'CONFIRMED', by: { id: ctx.user.id } } }]);
  });

  it('SYS-014: a closing-stock variance ends once reviewed', async () => {
    const ctx = await admin();
    const other = await admin();
    const { seller, bag } = await aLoadedVehicle(ctx, 5);
    const flagged = await declareClosingStock(seller.ctx, { lines: [{ skuId: bag.id, packs: 4 }] });
    await reviewClosingStock(ctx, flagged.id, { version: flagged.version, comment: 'One bag sold unrecorded' });
    expect(await copies(other, 'CLOSING_VARIANCE')).toMatchObject([{ resolution: { outcome: 'REVIEWED', by: { id: ctx.user.id } } }]);
  });

  it('SYS-014: a waiting check-in ends when authorised, tried again, opened on the seller\'s behalf, or left past its day', async () => {
    const ctx = await admin();
    const other = await admin();
    const vehicle = await aVehicle(ctx);
    const seller = await aSeller();
    await assignVehicle(ctx, vehicle.id, { sellerId: seller.account.id });
    await createZone(ctx, { name: 'Warehouse yard', lat: YARD.lat, lng: YARD.lng, radiusM: 300 });
    await updateToggles(ctx, [{ key: 'attendance.restricted_check_in', enabled: true }]);
    const DAY = businessDate(new Date(Date.now() + 48 * HOUR));
    const at = (hhmm: string, day = DAY) => ctxFor(seller.account, { now: new Date(`${day}T${hhmm}:00+03:00`) });

    // Tried again from inside the zone: the seller withdrew the first attempt.
    await checkInAs(await at('07:00'), { location: AWAY });
    await checkInAs(await at('07:10'), { location: YARD, odometer: 10_000 });
    expect((await copies(other, 'CHECK_IN_AWAITING_AUTHORISATION'))[0]).toMatchObject({ resolution: { outcome: 'WITHDRAWN', by: { id: seller.account.id } } });
    await checkOut(await at('12:00'), await captureFor(await at('12:00'), 10_010));

    // Authorised by one manager: every manager's copy says so.
    const away = await checkInAs(await at('13:00'), { location: AWAY, odometer: 10_010 });
    await authoriseZone(ctx, away.live?.id ?? '');
    expect((await copies(other, 'CHECK_IN_AWAITING_AUTHORISATION'))[0]).toMatchObject({ resolution: { outcome: 'AUTHORISED', by: { id: ctx.user.id } } });
    await checkOut(await at('14:00'), await captureFor(await at('14:00'), 10_020));

    // A manager opens the day instead: the waiting attempt is withdrawn by them.
    await checkInAs(await at('15:00'), { location: AWAY, odometer: 10_020 });
    await openDayOnBehalf(await ctxFor({ id: other.user.id, role: 'ADMIN' }, { now: new Date(`${DAY}T15:05:00+03:00`) }), { sellerId: seller.account.id, reason: 'Phone lost its signal' });
    expect((await copies(ctx, 'CHECK_IN_AWAITING_AUTHORISATION'))[0]).toMatchObject({ resolution: { outcome: 'WITHDRAWN', by: { id: other.user.id } } });
    await checkOut(await at('16:00'), await captureFor(await at('16:00'), 10_030));

    // Left waiting when the day closed: withdrawn by nobody.
    await checkInAs(await at('17:00'), { location: AWAY, odometer: 10_030 });
    expect((await closeFinishedDays(new Date(`${nextBusinessDate(DAY)}T03:00:00+03:00`))).withdrawn).toBe(1);
    expect((await copies(other, 'CHECK_IN_AWAITING_AUTHORISATION'))[0]).toMatchObject({ resolution: { outcome: 'WITHDRAWN', by: null } });
    expect(await outcomes(other, 'CHECK_IN_AWAITING_AUTHORISATION')).toEqual(['WITHDRAWN', 'WITHDRAWN', 'AUTHORISED', 'WITHDRAWN']);
  });

  it('SYS-014: a lost-order claim ends when decided; a second claim on the order is a request of its own', async () => {
    const ctx = await admin();
    const other = await admin();
    const setup = await aSellingSeller(ctx, { packs: 4 });
    const { orderId } = await raiseDispatchOrder(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 3 }] });
    const order = await releaseOrder(ctx, orderId ?? '', { version: 1, transportSlipPhotoId: await aPhoto(ctx, 'TRANSPORT_SLIP') });
    const claimed = await raiseLostClaim(setup.seller.ctx, order.id, { version: order.version, reason: 'Never arrived' });
    const rejected = await decideLostClaim(ctx, order.id, { version: claimed.version, approve: false, comment: 'Proof of delivery' });
    expect(await outcomes(other, 'LOST_CLAIM_RAISED')).toEqual(['REJECTED']);
    const again = await raiseLostClaim(setup.seller.ctx, order.id, { version: rejected.version, reason: 'The store says nothing came' });
    expect(await outcomes(other, 'LOST_CLAIM_RAISED')).toEqual([null, 'REJECTED']);
    await decideLostClaim(other, order.id, { version: again.version, approve: true, comment: 'Confirmed with the transporter' });
    expect(await copies(ctx, 'LOST_CLAIM_RAISED')).toMatchObject([
      { resolution: { outcome: 'APPROVED', by: { id: other.user.id } } }, { resolution: { outcome: 'REJECTED', by: { id: ctx.user.id } } },
    ]);
  });

  it('SYS-015: a dispatch request taken stops counting; taken over, the name changes; handed back, it is new again', async () => {
    const ctx = await admin();
    const [a, b] = [await admin(), await admin()];
    const setup = await aSellingSeller(ctx, { packs: 4 });
    await setPriceListItems(ctx, await basePriceListId(), [{ skuId: setup.pouch.id, price: '20.00' }]);
    await markNotificationsRead(ctx, {}); // the setup's own news
    const { orderId } = await raiseDispatchOrder(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 3 }] });
    const id = orderId ?? '';
    await markNotificationsRead(b, {});
    expect(await unread(ctx)).toBe(1);

    const taken = await takeOrder(a, id, { version: 1 });
    expect(await copies(ctx, 'DISPATCH_REQUESTED')).toMatchObject([{ resolution: { outcome: 'TAKEN', by: { id: a.user.id } } }]);
    expect(await unread(ctx)).toBe(0);
    const takenOver = await takeOrder(b, id, { version: taken.version });
    expect(await copies(a, 'DISPATCH_REQUESTED')).toMatchObject([{ resolution: { outcome: 'TAKEN', by: { id: b.user.id } } }]);

    // Handed back: waiting again, and new to everyone but whoever handed it back.
    const back = await releaseOrderBack(b, id, { version: takenOver.version });
    expect(await copies(a, 'DISPATCH_REQUESTED')).toMatchObject([{ read: false, resolution: null }]);
    expect(await copies(ctx, 'DISPATCH_REQUESTED')).toMatchObject([{ read: false, resolution: null }]);
    expect(await copies(b, 'DISPATCH_REQUESTED')).toMatchObject([{ read: true, resolution: null }]);
    expect(await unread(b)).toBe(0);

    await releaseOrder(a, id, { version: back.version, transportSlipPhotoId: await aPhoto(a, 'TRANSPORT_SLIP') });
    for (const reader of [ctx, b]) expect(await copies(reader, 'DISPATCH_REQUESTED')).toMatchObject([{ resolution: { outcome: 'RELEASED', by: { id: a.user.id } } }]);

    // Cancelled by the seller before anyone took it.
    const second = await raiseDispatchOrder(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.pouch.id, packs: 1 }] });
    await cancelOrder(setup.seller.ctx, second.orderId ?? '', { version: 1, reason: 'Store closed' });
    expect(await outcomes(b, 'DISPATCH_REQUESTED')).toEqual(['CANCELLED', 'RELEASED']);
  });
});

describe('what waits for a decision (ADR-0051, SYS-016)', () => {
  it('SYS-016: counted from the records, for the queues the reader decides, and never their own', async () => {
    const ctx = await admin();
    const other = await admin();
    const setup = await aSellingSeller(ctx, { creditMode: 'BILL_TO_BILL', creditLimit: '0.00' });
    expect(Object.keys(await waiting(ctx))).toEqual([
      'DISCOUNTS', 'CHECK_INS', 'DISPATCH', 'STORES', 'SETTLEMENTS', 'TRANSFERS', 'LOST_CLAIMS', 'WRITE_OFFS', 'PURCHASE_ORDERS', 'CLOSING_VARIANCES',
    ]);
    expect(Object.values(await waiting(ctx)).every((n) => n === 0)).toBe(true);

    // A store the admin onboarded for a seller waits for someone else.
    const onBehalf = await aStore(ctx, { sellerId: setup.seller.account.id });
    expect((await waiting(ctx)).STORES).toBe(0);
    expect((await waiting(other)).STORES).toBe(1);
    await decideStore(other, onBehalf.id, 'approve', { version: onBehalf.version });
    expect((await waiting(other)).STORES).toBe(0);

    // A discount request, until it is decided.
    const pending = await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 1, discount: '12' }], approvalReason: 'Competitor' });
    expect((await waiting(other)).DISCOUNTS).toBe(1);
    await decideDiscountRequest(other, pending.id, { version: pending.version, approve: false, comment: 'No' });
    expect((await waiting(other)).DISCOUNTS).toBe(0);

    // A handover waits for the manager it was handed to, and nobody else.
    await recordSale(setup.seller.ctx, { storeId: setup.store.id, lines: [{ skuId: setup.bag.id, packs: 1 }], payment: await paid(setup.seller.ctx, '90.00') });
    await submitSettlement(setup.seller.ctx, { route: 'MANAGER_HANDOVER', amount: '90.00', receivedById: other.user.id, photoId: await aPhoto(setup.seller.ctx, 'DEPOSIT_SLIP') });
    expect((await waiting(other)).SETTLEMENTS).toBe(1);
    expect((await waiting(ctx)).SETTLEMENTS).toBe(0);

    // A write-off — which sends no notification — waits for whoever did not submit it.
    const photoId = await aPhoto(setup.seller.ctx, 'WRITE_OFF_EVIDENCE');
    await submitWriteOff(setup.seller.ctx, { batchId: setup.bagBatch.batchId, packs: 1, reason: 'DAMAGED', photoId });
    expect((await waiting(ctx)).WRITE_OFFS).toBe(1);
  });

  it('SYS-016: a manager sees only the queues they can decide; a seller, none', async () => {
    expect(Object.keys(await waiting(await manager(['stores.approve'])))).toEqual(['STORES']);
    expect(await waitingForDecision((await aSeller()).ctx)).toEqual([]);
  });
});
