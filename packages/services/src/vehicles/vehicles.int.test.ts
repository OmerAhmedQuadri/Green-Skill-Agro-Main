import type { DomainError, PermissionCode } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { ownerQuery } from '../../test/db';
import { anAccount, ctxFor } from '../../test/factories';
import { aPhoto } from '../../test/media';
import { moreBags, okraInWarehouse } from '../../test/stock';
import { aLoadedVehicle, aSeller, aVehicle, captureFor, checkInAs } from '../../test/vehicles';
import { checkOut, closeFinishedDays } from '../attendance';
import { convertStock, getSkuStock, setClearancePriority, submitWriteOff } from '../inventory';
import { listMyNotifications, markNotificationsRead } from '../notifications';
import { setPriceListItems, listPriceLists } from '../pricing';
import { setCeiling, updateToggles } from '../system';
import {
  amendLoad, assignVehicle, cancelHandover, cancelLoad, confirmHandover, confirmLoad, createVehicle, declareClosingStock, disputeLoad,
  getLoad, getMyVehicle, getVehicle, issueLoad, listClosingStock, listLoads, listMyHandovers, listVehicles, proposeLoad,
  recordVehicleReturn, reviewClosingStock, unassignVehicle, updateVehicle,
} from './index';

const code = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: DomainError) => e.code ?? String(e));
const admin = async () => ctxFor(await anAccount('ADMIN'));
const manager = async (grants: PermissionCode[]) => ctxFor(await anAccount('MANAGER'), { overrides: new Map(grants.map((g) => [g, true])) });

async function priceOkra(ctx: Awaited<ReturnType<typeof admin>>, bagId: string, price = '100.00') {
  const base = (await listPriceLists(ctx)).find((l) => l.isBase);
  if (!base) throw new Error('no base list');
  await setPriceListItems(ctx, base.id, [{ skuId: bagId, price }]);
}

const positions = async (ctx: Awaited<ReturnType<typeof admin>>, skuId: string) => (await getSkuStock(ctx, skuId)).sku.positions;

describe('vehicle register (VEH-001..004)', () => {
  it('VEH-001: registration, description, odometer and status; the plate is normalised and unique', async () => {
    const ctx = await admin();
    const v = await createVehicle(ctx, { registration: ' abc  1234 ', description: 'Isuzu pickup', odometer: 45_210 });
    expect(v).toMatchObject({ registration: 'ABC 1234', description: 'Isuzu pickup', status: 'ACTIVE', odometer: 45_210, seller: null });
    expect(await code(createVehicle(ctx, { registration: 'ABC 1234', odometer: 1 }))).toBe('DUPLICATE_REGISTRATION');
    expect(await code(createVehicle(await manager(['inventory.view_all_stock']), { registration: 'XYZ 1', odometer: 1 }))).toBe('FORBIDDEN');
  });

  it('VEH-004: a corrected reading is a new reading with a note — history is never rewritten', async () => {
    const ctx = await admin();
    const v = await aVehicle(ctx, 1000);
    expect(await code(updateVehicle(ctx, v.id, { version: v.version, odometer: 1200 }))).toBe('REASON_REQUIRED');
    const fixed = await updateVehicle(ctx, v.id, { version: v.version, odometer: 1200, odometerNote: 'Dashboard replaced' });
    expect(fixed.odometer).toBe(1200);
    expect(fixed.readings.map((r) => [r.readingKm, r.source])).toEqual([[1200, 'CORRECTION'], [1000, 'REGISTRATION']]);
  });

  it('VEH-002: a vehicle is assigned for a period and every assignment is kept; a seller holds one vehicle', async () => {
    const ctx = await admin();
    const v = await aVehicle(ctx);
    const a = await aSeller();
    const b = await aSeller();
    expect((await assignVehicle(ctx, v.id, { sellerId: a.account.id })).outcome).toBe('ASSIGNED');
    const other = await aVehicle(ctx);
    expect(await code(assignVehicle(ctx, other.id, { sellerId: a.account.id }))).toBe('SELLER_HAS_VEHICLE');
    const moved = await assignVehicle(await admin(), v.id, { sellerId: b.account.id }); // empty: passes at once
    expect(moved.outcome).toBe('ASSIGNED');
    expect(moved.vehicle.seller?.id).toBe(b.account.id);
    expect(moved.vehicle.assignments.map((h) => [h.sellerId, h.endedAt === null])).toEqual([[b.account.id, true], [a.account.id, false]]);
  });

  it('VEH-003, STK-006: stock belongs to the vehicle; the register shows it with the accountable seller', async () => {
    const ctx = await admin();
    const { vehicle, seller, bag } = await aLoadedVehicle(ctx, 5);
    await priceOkra(ctx, bag.id, '100.00');
    const listed = (await listVehicles(ctx)).find((v) => v.id === vehicle.id);
    expect(listed).toMatchObject({ seller: { id: seller.account.id }, packs: 5, value: '500.00' });
    expect(await positions(ctx, bag.id)).toEqual({ warehouse: 15, vehicles: 5, dispatched: 0, total: 20 });
    expect(await code(unassignVehicle(ctx, vehicle.id))).toBe('VEHICLE_HAS_STOCK'); // never without an accountable seller
  });
});

describe('vehicle loads (workflow F, VEH-005..008)', () => {
  it('VEH-005: batches are proposed first-expiry-first-out, a flagged batch on top; a shortfall is reported', async () => {
    const ctx = await admin();
    const okra = await okraInWarehouse(ctx); // W1, 20 bags, expiring 2027-12-31
    await moreBags(ctx, okra, { packs: 10, lotNumber: 'W2', expiresOn: '2027-03-31' });
    const [fefo] = await proposeLoad(ctx, { lines: [{ skuId: okra.bag.id, packs: 25 }] });
    expect(fefo?.batches.map((b) => [b.lotNumber, b.packs])).toEqual([['W2', 10], ['W1', 15]]);
    const w1 = fefo?.batches.find((b) => b.lotNumber === 'W1');
    await setClearancePriority(ctx, w1?.batchId ?? '', { prioritised: true, note: 'Clear first' });
    const [flagged] = await proposeLoad(ctx, { lines: [{ skuId: okra.bag.id, packs: 25 }] });
    expect(flagged?.batches.map((b) => [b.lotNumber, b.flagged, b.packs])).toEqual([['W1', true, 20], ['W2', false, 5]]);
    const [short] = await proposeLoad(ctx, { lines: [{ skuId: okra.bag.id, packs: 33 }] });
    expect(short?.shortfallPacks).toBe(3);
  });

  it('VEH-006: a load over the ceiling warns first; acknowledged, it goes ahead and the warning is recorded', async () => {
    const ctx = await admin();
    const { vehicle, bag, bagBatch } = await aLoadedVehicle(ctx, 5);
    await priceOkra(ctx, bag.id, '100.00');
    await setCeiling(ctx, { kind: 'VEHICLE_STOCK_VALUE', sellerId: null, amount: '800.00' });
    const attempt = (acknowledgeCeiling?: boolean) => issueLoad(ctx, { vehicleId: vehicle.id, lines: [{ batchId: bagBatch.batchId, packs: 4 }], acknowledgeCeiling });
    const warned = await attempt().catch((e: DomainError) => e);
    expect(warned).toMatchObject({ code: 'CEILING_WARNING', details: { vehicleValue: '500.00', loadValue: '400.00', projected: '900.00', ceiling: '800.00', excess: '100.00' } });
    expect(await listLoads(ctx, { vehicleId: vehicle.id, open: true })).toEqual([]); // nothing written
    const load = await attempt(true);
    expect(load).toMatchObject({ status: 'ISSUED', loadValue: '400.00', vehicleValue: '500.00', ceiling: '800.00', ceilingAcknowledged: true });
  });

  it('VEH-006, OQ-005: a seller\'s own ceiling overrides the global one', async () => {
    const ctx = await admin();
    const { vehicle, seller, bag, bagBatch } = await aLoadedVehicle(ctx, 5);
    await priceOkra(ctx, bag.id, '100.00');
    await setCeiling(ctx, { kind: 'VEHICLE_STOCK_VALUE', sellerId: null, amount: '600.00' });
    await setCeiling(ctx, { kind: 'VEHICLE_STOCK_VALUE', sellerId: seller.account.id, amount: '5000.00' });
    expect((await issueLoad(ctx, { vehicleId: vehicle.id, lines: [{ batchId: bagBatch.batchId, packs: 4 }] })).ceilingAcknowledged).toBe(false);
  });

  it('VEH-007, VEH-008: the seller confirms on their own device; warehouse down, vehicle up, total unchanged', async () => {
    const ctx = await admin();
    const { bag, load, seller, vehicle, bagBatch } = await aLoadedVehicle(ctx, 5);
    expect(load).toMatchObject({ status: 'CONFIRMED', seller: { id: seller.account.id } });
    expect(await positions(ctx, bag.id)).toEqual({ warehouse: 15, vehicles: 5, dispatched: 0, total: 20 });
    const [group] = await ownerQuery<{ n: number; sum: string }>(`select count(*)::int as n, sum(quantity) as sum from stock_movements where reference_type = 'VEHICLE_LOADOUT'`);
    expect(group).toEqual({ n: 2, sum: '0.000' });
    // Someone else's load does not exist for them.
    const next = await issueLoad(ctx, { vehicleId: vehicle.id, lines: [{ batchId: bagBatch.batchId, packs: 1 }] });
    const stranger = await aSeller();
    await checkInAs(stranger.ctx, { withoutVehicle: true });
    expect(await code(confirmLoad(stranger.ctx, next.id, { version: next.version }))).toBe('NOT_FOUND');
    expect(await code(getLoad(stranger.ctx, next.id))).toBe('NOT_FOUND');
    expect((await listLoads(seller.ctx)).map((l) => l.id)).toContain(next.id);
  });

  it('VEH-007: until confirmed the load holds warehouse stock — it cannot be issued, written off or converted twice', async () => {
    const ctx = await admin();
    const { vehicle, bag, bagBatch } = await aLoadedVehicle(ctx, 5);
    await issueLoad(ctx, { vehicleId: vehicle.id, lines: [{ batchId: bagBatch.batchId, packs: 12 }] });
    expect(await positions(ctx, bag.id)).toMatchObject({ warehouse: 15, vehicles: 5 }); // nothing moved
    expect(await code(issueLoad(ctx, { vehicleId: vehicle.id, lines: [{ batchId: bagBatch.batchId, packs: 4 }] }))).toBe('INSUFFICIENT_STOCK');
    const photoId = await aPhoto(ctx, 'WRITE_OFF_EVIDENCE');
    expect(await code(submitWriteOff(ctx, { batchId: bagBatch.batchId, packs: 4, reason: 'DAMAGED', photoId }))).toBe('INSUFFICIENT_STOCK');
    expect(await code(submitWriteOff(ctx, { batchId: bagBatch.batchId, packs: 3, reason: 'DAMAGED', photoId }))).toBe('NO_ERROR');
  });

  it('VEH-007: a dispute needs a comment; the manager amends and the seller confirms the amended load', async () => {
    const ctx = await admin();
    const { vehicle, seller, bag, bagBatch } = await aLoadedVehicle(ctx, 5);
    const load = await issueLoad(ctx, { vehicleId: vehicle.id, lines: [{ batchId: bagBatch.batchId, packs: 6 }] });
    expect(await code(disputeLoad(seller.ctx, load.id, { version: load.version, comment: ' ' }))).toBe('REASON_REQUIRED');
    const disputed = await disputeLoad(seller.ctx, load.id, { version: load.version, comment: 'Only 4 bags loaded', lines: [{ batchId: bagBatch.batchId, note: 'Counted 4' }] });
    expect(disputed).toMatchObject({ status: 'DISPUTED', disputeComment: 'Only 4 bags loaded', lines: [{ disputeNote: 'Counted 4' }] });
    expect(await code(confirmLoad(seller.ctx, load.id, { version: disputed.version }))).toBe('INVALID_TRANSITION');
    const amended = await amendLoad(ctx, load.id, { version: disputed.version, lines: [{ batchId: bagBatch.batchId, packs: 4 }] });
    expect(amended).toMatchObject({ status: 'ISSUED', lines: [{ packs: 4 }] });
    await confirmLoad(seller.ctx, load.id, { version: amended.version });
    expect(await positions(ctx, bag.id)).toMatchObject({ warehouse: 11, vehicles: 9, total: 20 });
    const issuerNotes = (await listMyNotifications(ctx)).items.map((n) => n.kind);
    expect(issuerNotes).toEqual(expect.arrayContaining(['LOAD_DISPUTED', 'LOAD_CONFIRMED']));
  });

  it('VEH-007: a cancelled load releases its hold; a finished load stays finished', async () => {
    const ctx = await admin();
    const { vehicle, seller, bagBatch } = await aLoadedVehicle(ctx, 5);
    const load = await issueLoad(ctx, { vehicleId: vehicle.id, lines: [{ batchId: bagBatch.batchId, packs: 15 }] });
    const cancelled = await cancelLoad(ctx, load.id, { version: load.version, reason: 'Wrong vehicle' });
    expect(cancelled.status).toBe('CANCELLED');
    expect(await code(confirmLoad(seller.ctx, load.id, { version: cancelled.version }))).toBe('ALREADY_DECIDED');
    expect(await code(issueLoad(ctx, { vehicleId: vehicle.id, lines: [{ batchId: bagBatch.batchId, packs: 15 }] }))).toBe('NO_ERROR');
  });

  it('ATT-010, VEH-007: confirming a load needs an open check-in with that vehicle', async () => {
    const ctx = await admin();
    const { vehicle, seller, bagBatch } = await aLoadedVehicle(ctx, 5);
    const load = await issueLoad(ctx, { vehicleId: vehicle.id, lines: [{ batchId: bagBatch.batchId, packs: 1 }] });
    await checkOut(seller.ctx, await captureFor(seller.ctx, 10_050));
    expect(await code(confirmLoad(seller.ctx, load.id, { version: load.version }))).toBe('CHECK_IN_REQUIRED');
  });

  it('VEH-001: a vehicle in maintenance is not loaded; an unassigned one has nobody to confirm', async () => {
    const ctx = await admin();
    const { bag } = await okraInWarehouse(ctx);
    const [batch] = (await getSkuStock(ctx, bag.id)).batches;
    const v = await aVehicle(ctx);
    expect(await code(issueLoad(ctx, { vehicleId: v.id, lines: [{ batchId: batch?.batchId ?? '', packs: 1 }] }))).toBe('VEHICLE_NOT_ASSIGNED');
    const parked = await updateVehicle(ctx, v.id, { version: v.version, status: 'MAINTENANCE' });
    expect(await code(issueLoad(ctx, { vehicleId: parked.id, lines: [{ batchId: batch?.batchId ?? '', packs: 1 }] }))).toBe('VEHICLE_INACTIVE');
  });
});

describe('handover on reassignment (VEH-009, VEH-010)', () => {
  it('VEH-009: a vehicle with stock passes through a handover both sellers confirm; no stock moves', async () => {
    const ctx = await admin();
    const { vehicle, seller, bag } = await aLoadedVehicle(ctx, 5);
    const incoming = await aSeller();
    const proposed = await assignVehicle(ctx, vehicle.id, { sellerId: incoming.account.id });
    expect(proposed.outcome).toBe('HANDOVER_PROPOSED');
    expect(proposed.vehicle.seller?.id).toBe(seller.account.id); // still accountable until both confirm
    const [handover] = await listMyHandovers(incoming.ctx);
    if (!handover) throw new Error('no handover');
    const bystander = await aSeller();
    expect(await code(confirmHandover(bystander.ctx, handover.id))).toBe('NOT_FOUND');
    expect((await confirmHandover(incoming.ctx, handover.id)).status).toBe('PROPOSED');
    expect(await code(confirmHandover(incoming.ctx, handover.id))).toBe('ALREADY_DECIDED');
    const done = await confirmHandover(seller.ctx, handover.id);
    expect(done).toMatchObject({ status: 'CONFIRMED', stockList: [{ skuId: bag.id, packs: 5 }] });
    expect((await getVehicle(ctx, vehicle.id)).seller?.id).toBe(incoming.account.id);
    expect(await positions(ctx, bag.id)).toMatchObject({ warehouse: 15, vehicles: 5 });
    const [moved] = await ownerQuery<{ n: number }>(`select count(*)::int as n from stock_movements where reference_type <> 'GOODS_RECEIPT' and reference_type <> 'VEHICLE_LOADOUT'`);
    expect(moved?.n).toBe(0);
  });

  it('VEH-009: a proposed handover blocks new loads and can be cancelled by the manager', async () => {
    const ctx = await admin();
    const { vehicle, bagBatch } = await aLoadedVehicle(ctx, 5);
    const incoming = await aSeller();
    await assignVehicle(ctx, vehicle.id, { sellerId: incoming.account.id });
    expect(await code(issueLoad(ctx, { vehicleId: vehicle.id, lines: [{ batchId: bagBatch.batchId, packs: 1 }] }))).toBe('HANDOVER_PENDING');
    const pending = (await getVehicle(ctx, vehicle.id)).pendingHandover;
    if (!pending) throw new Error('no handover');
    expect((await cancelHandover(ctx, pending.id, { version: pending.version, reason: 'Route unchanged' })).status).toBe('CANCELLED');
    expect((await getVehicle(ctx, vehicle.id)).pendingHandover).toBeNull();
  });

  it('VEH-010, STK-012: the manager may return the stock to the warehouse first, then reassign at once', async () => {
    const ctx = await admin();
    const { vehicle, seller, bag, bagBatch } = await aLoadedVehicle(ctx, 5);
    const back = await recordVehicleReturn(ctx, { vehicleId: vehicle.id, reason: 'SELLER_LEAVING', lines: [{ batchId: bagBatch.batchId, packs: 5 }] });
    expect(back).toMatchObject({ reason: 'SELLER_LEAVING', sellerId: seller.account.id, lines: [{ packs: 5 }] });
    expect(back.number).toMatch(/^VR-\d{4}-\d{4}$/);
    expect(await positions(ctx, bag.id)).toEqual({ warehouse: 20, vehicles: 0, dispatched: 0, total: 20 });
    const incoming = await aSeller();
    expect((await assignVehicle(ctx, vehicle.id, { sellerId: incoming.account.id })).outcome).toBe('ASSIGNED');
    expect((await listMyNotifications(seller.ctx)).items.map((n) => n.kind)).toContain('VEHICLE_RETURN_RECORDED');
  });
});

describe('vehicle stock (STK-009, STK-012, WRO-001, CNV-009, EXP-007)', () => {
  it('STK-009: unsold stock stays on the vehicle overnight', async () => {
    const ctx = await admin();
    const { seller, bag } = await aLoadedVehicle(ctx, 5);
    await checkOut(seller.ctx, await captureFor(seller.ctx, 10_080));
    await closeFinishedDays(new Date(Date.now() + 2 * 86_400_000));
    expect(await positions(ctx, bag.id)).toMatchObject({ warehouse: 15, vehicles: 5, total: 20 });
  });

  it('STK-012: every reason is accepted; more than the vehicle holds is refused', async () => {
    const ctx = await admin();
    const { vehicle, bagBatch } = await aLoadedVehicle(ctx, 5);
    for (const reason of ['EXPIRY_RECALL', 'REDISTRIBUTION', 'STORE_RETURN', 'VEHICLE_WITHDRAWN', 'MANAGER_RECALL'] as const) {
      await recordVehicleReturn(ctx, { vehicleId: vehicle.id, reason, lines: [{ batchId: bagBatch.batchId, packs: 1 }] });
    }
    expect(await code(recordVehicleReturn(ctx, { vehicleId: vehicle.id, reason: 'MANAGER_RECALL', lines: [{ batchId: bagBatch.batchId, packs: 1 }] }))).toBe('INSUFFICIENT_STOCK');
    expect(await code(recordVehicleReturn(await manager(['vehicles.manage']), { vehicleId: vehicle.id, reason: 'MANAGER_RECALL', lines: [] }))).toBe('FORBIDDEN');
  });

  it('WRO-001: a checked-in seller writes off their own vehicle stock; it is held there until decided', async () => {
    const ctx = await admin();
    const { vehicle, seller, bagBatch } = await aLoadedVehicle(ctx, 5);
    const photoId = await aPhoto(seller.ctx, 'WRITE_OFF_EVIDENCE');
    const wo = await submitWriteOff(seller.ctx, { batchId: bagBatch.batchId, packs: 2, reason: 'DAMAGED', photoId });
    expect(wo).toMatchObject({ status: 'SUBMITTED', location: 'VEHICLE' });
    const mine = await getMyVehicle(seller.ctx);
    expect(mine.batches[0]).toMatchObject({ packs: 5, heldPacks: 2 });
    // The held packs cannot also be returned.
    expect(await code(recordVehicleReturn(ctx, { vehicleId: vehicle.id, reason: 'MANAGER_RECALL', lines: [{ batchId: bagBatch.batchId, packs: 4 }] }))).toBe('INSUFFICIENT_STOCK');
  });

  it('CNV-009: with the toggle on, a checked-in seller converts their own vehicle stock', async () => {
    const ctx = await admin();
    const { seller, bagBatch, pouch } = await aLoadedVehicle(ctx, 5);
    await updateToggles(ctx, [{ key: 'inventory.seller_conversion', enabled: true }]);
    const converter = await ctxFor(seller.account, { overrides: new Map([['inventory.convert', true]]) });
    const done = await convertStock(converter, { sourceBatchId: bagBatch.batchId, targetSkuId: pouch.id, sourcePacks: 1, targetPacks: 5, reason: 'Store wants pouches' });
    expect(done.targetPacks).toBe(5);
    const mine = await getMyVehicle(seller.ctx);
    expect(mine.batches.map((b) => [b.code, b.packs])).toEqual([['OKRA-PK-1KG', 5], ['OKRA-PK-5KG', 4]]);
  });

  it('EXP-007: the seller sees an indicator on affected items in their own stock', async () => {
    const ctx = await admin();
    const { seller, bagBatch } = await aLoadedVehicle(ctx, 5);
    expect((await getMyVehicle(seller.ctx)).flaggedCount).toBe(0);
    await setClearancePriority(ctx, bagBatch.batchId, { prioritised: true, note: 'Sell first' });
    const mine = await getMyVehicle(seller.ctx);
    expect(mine.flaggedCount).toBe(1);
    expect(mine.batches[0]?.expiry).toMatchObject({ flagged: true, prioritised: true });
  });

  it('USR-013: a seller without a vehicle sees an empty vehicle, not an error', async () => {
    const seller = await aSeller();
    expect(await getMyVehicle(seller.ctx)).toMatchObject({ vehicle: null, batches: [], packs: 0 });
  });
});

describe('closing stock (STK-010, STK-011)', () => {
  it('STK-010, STK-011: an exact count matches; a different one is flagged, reviewed, and stock is never adjusted', async () => {
    const ctx = await admin();
    const { seller, bag } = await aLoadedVehicle(ctx, 5);
    const flagged = await declareClosingStock(seller.ctx, { lines: [{ skuId: bag.id, packs: 4 }] });
    expect(flagged).toMatchObject({ status: 'VARIANCE_FLAGGED', lines: [{ skuId: bag.id, declaredPacks: 4, systemPacks: 5, variancePacks: -1 }] });
    expect(await positions(ctx, bag.id)).toMatchObject({ vehicles: 5 }); // a declaration, not an adjustment
    expect(await code(declareClosingStock(seller.ctx, { lines: [{ skuId: bag.id, packs: 5 }] }))).toBe('ALREADY_DECLARED');
    expect((await listMyNotifications(ctx)).items.map((n) => n.kind)).toContain('CLOSING_VARIANCE');
    expect(await code(reviewClosingStock(ctx, flagged.id, { version: flagged.version, comment: '' }))).toBe('REASON_REQUIRED');
    const reviewed = await reviewClosingStock(ctx, flagged.id, { version: flagged.version, comment: 'One bag sold unrecorded; raising a write-off' });
    expect(reviewed).toMatchObject({ status: 'REVIEWED', reviewComment: 'One bag sold unrecorded; raising a write-off' });
    expect((await listClosingStock(seller.ctx)).map((d) => d.id)).toEqual([flagged.id]);
  });

  it('STK-010: a matching count is MATCHED; declaring needs an open day with the vehicle', async () => {
    const ctx = await admin();
    const { seller, bag } = await aLoadedVehicle(ctx, 5);
    expect((await declareClosingStock(seller.ctx, { lines: [{ skuId: bag.id, packs: 5 }] })).status).toBe('MATCHED');
    const other = await aSeller();
    expect(await code(declareClosingStock(other.ctx, { lines: [] }))).toBe('CHECK_IN_REQUIRED');
  });
});

describe('notifications (ADR-0034)', () => {
  it('VEH-007: the seller is notified of a load; notifications are read one by one or all at once', async () => {
    const ctx = await admin();
    const { seller, vehicle, bagBatch } = await aLoadedVehicle(ctx, 5);
    await issueLoad(ctx, { vehicleId: vehicle.id, lines: [{ batchId: bagBatch.batchId, packs: 1 }] });
    const mine = await listMyNotifications(seller.ctx);
    expect(mine.items.map((n) => n.kind)).toEqual(['LOAD_ISSUED', 'LOAD_ISSUED']);
    expect(mine.items[0]).toMatchObject({ params: { packs: 1 }, link: '/field/vehicle', read: false });
    expect(mine.unread).toBe(2);
    expect((await markNotificationsRead(seller.ctx, { ids: [mine.items[0]?.id ?? ''] })).unread).toBe(1);
    expect((await markNotificationsRead(ctx, {})).unread).toBe(0); // the admin's own; the seller's untouched
    expect((await listMyNotifications(seller.ctx)).unread).toBe(1);
    expect((await markNotificationsRead(seller.ctx, {})).unread).toBe(0);
  });
});
