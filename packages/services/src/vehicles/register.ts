import {
  confirmHandoverBy, DomainError, HOLDING_LOAD_STATUSES, normaliseRegistration, odometerReading,
  type HandoverStatus, type Money, type VehicleStatus,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { aliasedTable, and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { currentAssignment, lastOdometer } from '../attendance';
import { authorize, authorizeAny, type Ctx } from '../context';
import { notify } from '../notifications';
import { audit, inTx, mapUniqueViolations, type Executor, type Tx } from '../platform';
import { getDb } from '../runtime';
import { valueOf, vehicleBatches, type VehicleBatch } from './stock';

const { vehicles, vehicleAssignments, vehicleHandovers, vehicleLoadouts, odometerReadings, users } = schema;

const READERS = ['vehicles.manage', 'inventory.view_all_stock', 'inventory.issue_to_vehicle'] as const;

export type Handover = {
  readonly id: string; readonly vehicleId: string; readonly registration: string; readonly status: HandoverStatus;
  readonly outgoing: { readonly id: string; readonly name: string; readonly confirmedAt: Date | null };
  readonly incoming: { readonly id: string; readonly name: string; readonly confirmedAt: Date | null };
  readonly proposedAt: Date; readonly completedAt: Date | null; readonly cancelledAt: Date | null; readonly cancelReason: string | null;
  readonly stockList: readonly { skuId: string; code: string; packs: number }[] | null; readonly version: number;
};

export type Vehicle = {
  readonly id: string; readonly registration: string; readonly description: string | null; readonly status: VehicleStatus;
  readonly odometer: number | null;
  readonly seller: { readonly id: string; readonly name: string; readonly since: Date } | null;
  readonly assignments: readonly { readonly sellerId: string; readonly name: string; readonly startedAt: Date; readonly endedAt: Date | null }[];
  readonly readings: readonly { readonly readingKm: number; readonly source: 'REGISTRATION' | 'CHECK_IN' | 'CHECK_OUT' | 'CORRECTION'; readonly recordedAt: Date; readonly note: string | null }[];
  readonly batches: readonly VehicleBatch[]; readonly value: Money; readonly packs: number;
  readonly pendingHandover: Handover | null; readonly outstandingLoads: number;
  readonly version: number;
};

const outgoingUser = aliasedTable(users, 'outgoing_user');
const incomingUser = aliasedTable(users, 'incoming_user');

async function loadHandovers(db: Executor, where: ReturnType<typeof and>): Promise<Handover[]> {
  const rows = await db.select({ h: vehicleHandovers, registration: vehicles.registration, outName: outgoingUser.name, inName: incomingUser.name })
    .from(vehicleHandovers).innerJoin(vehicles, eq(vehicles.id, vehicleHandovers.vehicleId))
    .innerJoin(outgoingUser, eq(outgoingUser.id, vehicleHandovers.outgoingSellerId))
    .innerJoin(incomingUser, eq(incomingUser.id, vehicleHandovers.incomingSellerId))
    .where(where).orderBy(desc(vehicleHandovers.proposedAt));
  return rows.map((r) => ({
    id: r.h.id, vehicleId: r.h.vehicleId, registration: r.registration, status: r.h.status,
    outgoing: { id: r.h.outgoingSellerId, name: r.outName, confirmedAt: r.h.outgoingConfirmedAt },
    incoming: { id: r.h.incomingSellerId, name: r.inName, confirmedAt: r.h.incomingConfirmedAt },
    proposedAt: r.h.proposedAt, completedAt: r.h.completedAt, cancelledAt: r.h.cancelledAt, cancelReason: r.h.cancelReason,
    stockList: r.h.stockList as Handover['stockList'], version: r.h.version,
  }));
}

async function loadVehicle(db: Executor, id: string): Promise<Vehicle> {
  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, id));
  if (!vehicle) throw new DomainError('NOT_FOUND', { entity: 'vehicle', id });
  // One after the other: `db` may be a transaction — a single connection.
  const history = await db.select({ a: vehicleAssignments, name: users.name }).from(vehicleAssignments).innerJoin(users, eq(users.id, vehicleAssignments.sellerId))
    .where(eq(vehicleAssignments.vehicleId, id)).orderBy(desc(vehicleAssignments.startedAt));
  const readings = await db.select().from(odometerReadings).where(eq(odometerReadings.vehicleId, id))
    .orderBy(desc(odometerReadings.recordedAt), desc(odometerReadings.createdAt)).limit(20);
  const lines = await vehicleBatches(db, [id]);
  const [pending] = await loadHandovers(db, and(eq(vehicleHandovers.vehicleId, id), eq(vehicleHandovers.status, 'PROPOSED')));
  const outstanding = await db.select({ id: vehicleLoadouts.id }).from(vehicleLoadouts)
    .where(and(eq(vehicleLoadouts.vehicleId, id), inArray(vehicleLoadouts.status, [...HOLDING_LOAD_STATUSES])));
  const current = history.find((h) => h.a.endedAt === null);
  return {
    id: vehicle.id, registration: vehicle.registration, description: vehicle.description, status: vehicle.status,
    odometer: readings[0]?.readingKm ?? null,
    seller: current ? { id: current.a.sellerId, name: current.name, since: current.a.startedAt } : null,
    assignments: history.map((h) => ({ sellerId: h.a.sellerId, name: h.name, startedAt: h.a.startedAt, endedAt: h.a.endedAt })),
    readings: readings.map((r) => ({ readingKm: r.readingKm, source: r.source, recordedAt: r.recordedAt, note: r.note })),
    batches: lines, value: valueOf(lines), packs: lines.reduce((n, l) => n + l.packs, 0),
    pendingHandover: pending ?? null, outstandingLoads: outstanding.length, version: vehicle.version,
  };
}

export async function getVehicle(ctx: Ctx, id: string): Promise<Vehicle> {
  authorizeAny(ctx, [...READERS]);
  return loadVehicle(getDb(), id);
}

const duplicate = { vehicles_registration_unique: new DomainError('DUPLICATE_REGISTRATION') };

/** VEH-001: registration, description, the odometer as it stands, and status. */
export async function createVehicle(ctx: Ctx, input: { registration: string; description?: string | null | undefined; odometer: number }): Promise<Vehicle> {
  authorize(ctx, 'vehicles.manage');
  const registration = normaliseRegistration(input.registration);
  const reading = odometerReading(input.odometer);
  return inTx(ctx, async (tx) => {
    const [row] = await mapUniqueViolations(tx.insert(vehicles).values({
      registration, description: input.description?.trim() || null, branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: vehicles.id }), duplicate);
    if (!row) throw new Error('vehicle insert returned nothing');
    await tx.insert(odometerReadings).values({
      vehicleId: row.id, readingKm: reading, source: 'REGISTRATION', recordedAt: ctx.now, recordedBy: ctx.user.id, branchId: ctx.branchId,
    });
    await audit(tx, ctx, { action: 'vehicles.created', entityType: 'vehicle', entityId: row.id, after: { registration, odometer: reading } });
    return loadVehicle(tx, row.id);
  });
}

/**
 * VEH-001: edit the record. A corrected odometer reading is a new reading
 * with a note — readings are never rewritten (VEH-004). Retiring needs the
 * vehicle empty and unassigned.
 */
export async function updateVehicle(
  ctx: Ctx, id: string,
  input: {
    version: number; registration?: string | undefined; description?: string | null | undefined; status?: VehicleStatus | undefined;
    odometer?: number | undefined; odometerNote?: string | undefined;
  },
): Promise<Vehicle> {
  authorize(ctx, 'vehicles.manage');
  return inTx(ctx, async (tx) => {
    const [current] = await tx.select().from(vehicles).where(eq(vehicles.id, id)).for('update');
    if (!current) throw new DomainError('NOT_FOUND', { entity: 'vehicle', id });
    if (current.version !== input.version) throw new DomainError('VERSION_CONFLICT', { entity: 'vehicle', id });
    const registration = input.registration === undefined ? current.registration : normaliseRegistration(input.registration);
    const status = input.status ?? current.status;
    if (status === 'RETIRED' && current.status !== 'RETIRED') {
      const state = await loadVehicle(tx, id);
      if (state.seller) throw new DomainError('VEHICLE_HAS_STOCK', { reason: 'ASSIGNED' });
      if (state.packs > 0 || state.outstandingLoads > 0) throw new DomainError('VEHICLE_HAS_STOCK', { packs: state.packs });
    }
    await mapUniqueViolations(tx.update(vehicles).set({
      registration, description: input.description === undefined ? current.description : input.description?.trim() || null, status,
      updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1,
    }).where(eq(vehicles.id, id)), duplicate);
    if (input.odometer !== undefined) {
      const note = input.odometerNote?.trim();
      if (!note) throw new DomainError('REASON_REQUIRED', { action: 'odometer_correction' });
      await tx.insert(odometerReadings).values({
        vehicleId: id, readingKm: odometerReading(input.odometer), source: 'CORRECTION', note, recordedAt: ctx.now, recordedBy: ctx.user.id, branchId: ctx.branchId,
      });
    }
    await audit(tx, ctx, {
      action: 'vehicles.updated', entityType: 'vehicle', entityId: id,
      before: { registration: current.registration, description: current.description, status: current.status },
      after: { registration, description: input.description, status, odometer: input.odometer ?? null },
    });
    return loadVehicle(tx, id);
  });
}

// ---------------------------------------------------------------- assignment and handover

async function assertSeller(db: Executor, sellerId: string) {
  const [row] = await db.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, sellerId));
  if (row?.role !== 'SELLER' || row.status !== 'ACTIVE') throw new DomainError('NOT_FOUND', { entity: 'seller', id: sellerId });
}

const lockVehicle = async (tx: Tx, id: string) => {
  const [row] = await tx.select().from(vehicles).where(eq(vehicles.id, id)).for('update');
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'vehicle', id });
  return row;
};

const assignmentClash = { vehicle_assignments_one_per_seller: new DomainError('SELLER_HAS_VEHICLE') };

async function startAssignment(tx: Tx, ctx: Ctx, vehicleId: string, sellerId: string) {
  await mapUniqueViolations(tx.insert(vehicleAssignments).values({
    vehicleId, sellerId, startedAt: ctx.now, assignedBy: ctx.user.id, branchId: ctx.branchId,
  }), assignmentClash);
}

async function endAssignment(tx: Tx, ctx: Ctx, vehicleId: string, note: string | null) {
  await tx.update(vehicleAssignments).set({ endedAt: ctx.now, endedBy: ctx.user.id, endNote: note })
    .where(and(eq(vehicleAssignments.vehicleId, vehicleId), isNull(vehicleAssignments.endedAt)));
}

/**
 * VEH-002, 009, 010 (ADR-0031): assign a vehicle to a seller. Empty, it
 * passes at once and the old assignment ends. Carrying stock, it becomes a
 * handover both sellers confirm — or the manager returns the stock first.
 */
export async function assignVehicle(ctx: Ctx, vehicleId: string, input: { sellerId: string }): Promise<{ outcome: 'ASSIGNED' | 'HANDOVER_PROPOSED'; vehicle: Vehicle }> {
  authorize(ctx, 'vehicles.manage');
  return inTx(ctx, async (tx) => {
    const vehicle = await lockVehicle(tx, vehicleId);
    if (vehicle.status !== 'ACTIVE') throw new DomainError('VEHICLE_INACTIVE', { status: vehicle.status });
    await assertSeller(tx, input.sellerId);
    const held = await currentAssignment(tx, input.sellerId);
    if (held) throw new DomainError('SELLER_HAS_VEHICLE', { vehicleId: held.vehicleId, registration: held.registration });
    const state = await loadVehicle(tx, vehicleId);
    if (state.pendingHandover) throw new DomainError('HANDOVER_PENDING');
    if (state.outstandingLoads > 0) throw new DomainError('VEHICLE_HAS_STOCK', { reason: 'LOAD_OUTSTANDING' });

    if (state.seller && state.packs > 0) {
      const [handover] = await tx.insert(vehicleHandovers).values({
        vehicleId, outgoingSellerId: state.seller.id, incomingSellerId: input.sellerId, proposedAt: ctx.now, proposedBy: ctx.user.id,
        branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
      }).returning({ id: vehicleHandovers.id });
      if (!handover) throw new Error('handover insert returned nothing');
      await notify(tx, ctx, { users: [state.seller.id, input.sellerId] }, 'HANDOVER_PROPOSED', { registration: vehicle.registration }, '/field/vehicle');
      await audit(tx, ctx, { action: 'vehicles.handover_proposed', entityType: 'vehicle_handover', entityId: handover.id, after: { vehicleId, from: state.seller.id, to: input.sellerId } });
      return { outcome: 'HANDOVER_PROPOSED' as const, vehicle: await loadVehicle(tx, vehicleId) };
    }
    if (state.seller) await endAssignment(tx, ctx, vehicleId, null);
    await startAssignment(tx, ctx, vehicleId, input.sellerId);
    await audit(tx, ctx, { action: 'vehicles.assigned', entityType: 'vehicle', entityId: vehicleId, before: { sellerId: state.seller?.id ?? null }, after: { sellerId: input.sellerId } });
    return { outcome: 'ASSIGNED' as const, vehicle: await loadVehicle(tx, vehicleId) };
  });
}

/** Ends the assignment. Stock is never left without an accountable seller (ADR-0031). */
export async function unassignVehicle(ctx: Ctx, vehicleId: string, input: { note?: string | null | undefined } = {}): Promise<Vehicle> {
  authorize(ctx, 'vehicles.manage');
  return inTx(ctx, async (tx) => {
    await lockVehicle(tx, vehicleId);
    const state = await loadVehicle(tx, vehicleId);
    if (!state.seller) throw new DomainError('VEHICLE_NOT_ASSIGNED');
    if (state.pendingHandover) throw new DomainError('HANDOVER_PENDING');
    if (state.packs > 0 || state.outstandingLoads > 0) throw new DomainError('VEHICLE_HAS_STOCK', { packs: state.packs });
    await endAssignment(tx, ctx, vehicleId, input.note?.trim() || null);
    await audit(tx, ctx, { action: 'vehicles.unassigned', entityType: 'vehicle', entityId: vehicleId, before: { sellerId: state.seller.id } });
    return loadVehicle(tx, vehicleId);
  });
}

/**
 * VEH-009: each seller confirms on their own phone. The second confirmation
 * completes it: the old assignment ends, the new one starts, and the stock
 * list at that moment is kept as the record. Nothing moves.
 */
export async function confirmHandover(ctx: Ctx, id: string): Promise<Handover> {
  authorize(ctx, 'inventory.confirm_load');
  return inTx(ctx, async (tx) => {
    const [h] = await tx.select().from(vehicleHandovers).where(eq(vehicleHandovers.id, id)).for('update');
    if (!h) throw new DomainError('NOT_FOUND', { entity: 'vehicle_handover', id });
    const { side, complete } = confirmHandoverBy(h, ctx.user.id);
    const confirmed = side === 'OUTGOING' ? { outgoingConfirmedAt: ctx.now } : { incomingConfirmedAt: ctx.now };
    let stockList: { skuId: string; code: string; packs: number }[] | null = null;
    if (complete) {
      await lockVehicle(tx, h.vehicleId);
      const lines = await vehicleBatches(tx, [h.vehicleId]);
      const bySku = new Map<string, { skuId: string; code: string; packs: number }>();
      for (const l of lines) {
        const e = bySku.get(l.skuId) ?? { skuId: l.skuId, code: l.code, packs: 0 };
        e.packs += l.packs;
        bySku.set(l.skuId, e);
      }
      stockList = [...bySku.values()];
      await endAssignment(tx, ctx, h.vehicleId, 'HANDOVER');
      await startAssignment(tx, ctx, h.vehicleId, h.incomingSellerId);
    }
    await tx.update(vehicleHandovers).set({
      ...confirmed, ...(complete ? { status: 'CONFIRMED' as const, completedAt: ctx.now, stockList } : {}),
      updatedAt: ctx.now, updatedBy: ctx.user.id, version: h.version + 1,
    }).where(eq(vehicleHandovers.id, id));
    if (complete) {
      const [v] = await tx.select({ registration: vehicles.registration }).from(vehicles).where(eq(vehicles.id, h.vehicleId));
      await notify(tx, ctx, { users: [h.proposedBy, h.outgoingSellerId, h.incomingSellerId] }, 'HANDOVER_COMPLETED', { registration: v?.registration ?? '' }, `/console/vehicles/${h.vehicleId}`);
    }
    await audit(tx, ctx, { action: complete ? 'vehicles.handover_completed' : 'vehicles.handover_confirmed', entityType: 'vehicle_handover', entityId: id, after: { side, stockList } });
    const [out] = await loadHandovers(tx, and(eq(vehicleHandovers.id, id)));
    if (!out) throw new Error('handover vanished');
    return out;
  });
}

export async function cancelHandover(ctx: Ctx, id: string, input: { version: number; reason: string }): Promise<Handover> {
  authorize(ctx, 'vehicles.manage');
  const reason = input.reason.trim();
  if (!reason) throw new DomainError('REASON_REQUIRED', { action: 'cancel_handover' });
  return inTx(ctx, async (tx) => {
    const [h] = await tx.select().from(vehicleHandovers).where(eq(vehicleHandovers.id, id)).for('update');
    if (!h) throw new DomainError('NOT_FOUND', { entity: 'vehicle_handover', id });
    if (h.version !== input.version) throw new DomainError('VERSION_CONFLICT', { entity: 'vehicle_handover', id });
    if (h.status !== 'PROPOSED') throw new DomainError('ALREADY_DECIDED', { status: h.status });
    await tx.update(vehicleHandovers).set({ status: 'CANCELLED', cancelledAt: ctx.now, cancelReason: reason, updatedAt: ctx.now, updatedBy: ctx.user.id, version: h.version + 1 })
      .where(eq(vehicleHandovers.id, id));
    await audit(tx, ctx, { action: 'vehicles.handover_cancelled', entityType: 'vehicle_handover', entityId: id, after: { reason } });
    const [out] = await loadHandovers(tx, and(eq(vehicleHandovers.id, id)));
    if (!out) throw new Error('handover vanished');
    return out;
  });
}

/** A seller's handovers waiting on them or the other party. */
export async function listMyHandovers(ctx: Ctx): Promise<Handover[]> {
  authorize(ctx, 'inventory.confirm_load');
  return loadHandovers(getDb(), and(
    eq(vehicleHandovers.status, 'PROPOSED'),
    or(eq(vehicleHandovers.outgoingSellerId, ctx.user.id), eq(vehicleHandovers.incomingSellerId, ctx.user.id)),
  ));
}

/** VEH-001: the register for the console, with each vehicle's odometer. */
export async function listVehicles(ctx: Ctx): Promise<(Omit<Vehicle, 'assignments' | 'readings' | 'batches' | 'pendingHandover'> & { readonly handoverPending: boolean })[]> {
  authorizeAny(ctx, [...READERS]);
  const db = getDb();
  const ids = (await db.select({ id: vehicles.id }).from(vehicles).orderBy(vehicles.registration)).map((r) => r.id);
  const out = [];
  for (const id of ids) {
    const v = await loadVehicle(db, id);
    out.push({
      id: v.id, registration: v.registration, description: v.description, status: v.status, odometer: v.odometer ?? (await lastOdometer(db, id)),
      seller: v.seller, value: v.value, packs: v.packs, outstandingLoads: v.outstandingLoads, handoverPending: v.pendingHandover !== null, version: v.version,
    });
  }
  return out;
}

/** Active sellers and the vehicle each holds — for assigning vehicles and stores, and opening days (VEH-002, STO-007, ATT-011). */
export async function listSellers(ctx: Ctx): Promise<{ id: string; name: string; vehicle: { id: string; registration: string } | null }[]> {
  authorizeAny(ctx, ['vehicles.manage', 'attendance.manage', 'attendance.view', 'inventory.issue_to_vehicle', 'stores.reassign', 'stores.view_all']);
  const rows = await getDb().select({ id: users.id, name: users.name, vehicleId: vehicles.id, registration: vehicles.registration }).from(users)
    .leftJoin(vehicleAssignments, and(eq(vehicleAssignments.sellerId, users.id), isNull(vehicleAssignments.endedAt)))
    .leftJoin(vehicles, eq(vehicles.id, vehicleAssignments.vehicleId))
    .where(and(eq(users.role, 'SELLER'), eq(users.status, 'ACTIVE'))).orderBy(users.name);
  return rows.map((r) => ({ id: r.id, name: r.name, vehicle: r.vehicleId && r.registration ? { id: r.vehicleId, registration: r.registration } : null }));
}
