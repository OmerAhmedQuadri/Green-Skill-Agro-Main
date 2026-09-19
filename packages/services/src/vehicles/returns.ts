import {
  DomainError, packCount, toBaseUnits, VEHICLE_RETURN_REASONS,
  type BatchId, type Leg, type Quantity, type VehicleReturnReason,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { sizeOf } from '../catalogue';
import { authorize, authorizeAny, type Ctx } from '../context';
import { availableOf, batchRefs, postStockMovements, warehouseAccount } from '../inventory';
import { notify } from '../notifications';
import { audit, inTx, nextDocumentNumber } from '../platform';
import { getDb } from '../runtime';
import { unitsOf } from './stock';

const { vehicles, vehicleAssignments, vehicleReturns, vehicleReturnLines, batches, skus, users } = schema;

export type VehicleReturn = {
  readonly id: string; readonly number: string; readonly reason: VehicleReturnReason; readonly note: string | null;
  readonly vehicle: { readonly id: string; readonly registration: string }; readonly sellerId: string | null;
  readonly recordedAt: Date; readonly recordedBy: string;
  readonly lines: readonly { readonly batchId: BatchId; readonly code: string; readonly lotNumber: string | null; readonly packs: number }[];
};

/**
 * STK-012 (ADR-0031): stock comes back from a vehicle to the warehouse — an
 * expiry recall, redistribution, the seller leaving, a store's return, the
 * vehicle withdrawn, a manager's recall. Recorded as it arrives and posted at
 * once: vehicle down, warehouse up.
 */
export async function recordVehicleReturn(
  ctx: Ctx, input: { vehicleId: string; reason: VehicleReturnReason; note?: string | null | undefined; lines: readonly { batchId: string; packs: number }[] },
): Promise<VehicleReturn> {
  authorize(ctx, 'inventory.issue_to_vehicle');
  if (!VEHICLE_RETURN_REASONS.includes(input.reason)) throw new DomainError('INVALID_SETTING', { field: 'reason' });
  if (input.lines.length === 0) throw new DomainError('EMPTY_LOAD');
  const ids = input.lines.map((l) => l.batchId);
  if (new Set(ids).size !== ids.length) throw new DomainError('DUPLICATE_SKU', { reason: 'DUPLICATE_BATCH' });
  return inTx(ctx, async (tx) => {
    const [vehicle] = await tx.select().from(vehicles).where(eq(vehicles.id, input.vehicleId)).for('update');
    if (!vehicle) throw new DomainError('NOT_FOUND', { entity: 'vehicle', id: input.vehicleId });
    const [assignment] = await tx.select({ sellerId: vehicleAssignments.sellerId }).from(vehicleAssignments)
      .where(and(eq(vehicleAssignments.vehicleId, vehicle.id), isNull(vehicleAssignments.endedAt)));
    const account = { kind: 'VEHICLE' as const, vehicleId: vehicle.id };
    const warehouse = await warehouseAccount(tx);
    const rows = await tx.select({ batch: batches, sku: skus }).from(batches).innerJoin(skus, eq(skus.id, batches.skuId)).where(inArray(batches.id, ids));
    const refs = await batchRefs(tx, ids);
    const prepared = [];
    for (const line of input.lines) {
      const row = rows.find((r) => r.batch.id === line.batchId);
      if (!row) throw new DomainError('NOT_FOUND', { entity: 'batch', id: line.batchId });
      if (line.packs <= 0) throw new DomainError('INVALID_PACK_COUNT', { value: line.packs });
      const quantity = toBaseUnits(packCount(line.packs), unitsOf(sizeOf(row.sku)));
      // Stock held by a pending write-off on the vehicle stays there until it is decided.
      const available = await availableOf(tx, line.batchId, account);
      if (available.lt(quantity)) throw new DomainError('INSUFFICIENT_STOCK', { batchId: line.batchId, code: row.sku.code, available: available.toString(), requested: quantity });
      prepared.push({ ...line, quantity, balanceKey: refs.get(line.batchId)?.balanceKey ?? line.batchId });
    }
    const returnId = newId();
    const legs: Leg[] = prepared.flatMap((l) => [
      { batchId: l.batchId, balanceKey: l.balanceKey, account, quantity: `-${l.quantity}` as Quantity },
      { batchId: l.batchId, balanceKey: l.balanceKey, account: warehouse, quantity: l.quantity },
    ]);
    // Posted first: the record is append-only and carries the group it posted.
    const { groupId } = await postStockMovements(tx, ctx, { referenceType: 'VEHICLE_RETURN', referenceId: returnId, legs });
    const [created] = await tx.insert(vehicleReturns).values({
      id: returnId, number: await nextDocumentNumber(tx, 'VR', ctx.now), vehicleId: vehicle.id, sellerId: assignment?.sellerId ?? null,
      warehouseId: warehouse.warehouseId, reason: input.reason, note: input.note?.trim() || null, movementGroupId: groupId,
      recordedAt: ctx.now, recordedBy: ctx.user.id, branchId: ctx.branchId,
    }).returning({ id: vehicleReturns.id, number: vehicleReturns.number });
    if (!created) throw new Error('vehicle return insert returned nothing');
    await tx.insert(vehicleReturnLines).values(prepared.map((l) => ({ returnId, batchId: l.batchId, packs: l.packs, quantity: l.quantity })));
    if (assignment) {
      await notify(tx, ctx, { users: [assignment.sellerId] }, 'VEHICLE_RETURN_RECORDED', { number: created.number, registration: vehicle.registration }, '/field/vehicle');
    }
    await audit(tx, ctx, { action: 'vehicles.stock_returned', entityType: 'vehicle_return', entityId: created.id, after: { groupId, reason: input.reason, lines: input.lines } });
    const [out] = await loadReturns(tx, eq(vehicleReturns.id, created.id));
    if (!out) throw new Error('vehicle return vanished');
    return out;
  });
}

async function loadReturns(db: Parameters<typeof batchRefs>[0], where: ReturnType<typeof eq>): Promise<VehicleReturn[]> {
  const rows = await db.select({ r: vehicleReturns, registration: vehicles.registration, recorder: users.name }).from(vehicleReturns)
    .innerJoin(vehicles, eq(vehicles.id, vehicleReturns.vehicleId)).innerJoin(users, eq(users.id, vehicleReturns.recordedBy))
    .where(where).orderBy(desc(vehicleReturns.recordedAt)).limit(100);
  if (rows.length === 0) return [];
  const lines = await db.select({ line: vehicleReturnLines, code: skus.code, lot: batches.lotNumber }).from(vehicleReturnLines)
    .innerJoin(batches, eq(batches.id, vehicleReturnLines.batchId)).innerJoin(skus, eq(skus.id, batches.skuId))
    .where(inArray(vehicleReturnLines.returnId, rows.map((r) => r.r.id))).orderBy(asc(skus.code));
  return rows.map((r) => ({
    id: r.r.id, number: r.r.number, reason: r.r.reason, note: r.r.note, vehicle: { id: r.r.vehicleId, registration: r.registration },
    sellerId: r.r.sellerId, recordedAt: r.r.recordedAt, recordedBy: r.recorder,
    lines: lines.filter((l) => l.line.returnId === r.r.id).map((l) => ({ batchId: l.line.batchId as BatchId, code: l.code, lotNumber: l.lot, packs: l.line.packs })),
  }));
}

export async function listVehicleReturns(ctx: Ctx, filter: { vehicleId: string }): Promise<VehicleReturn[]> {
  authorizeAny(ctx, ['inventory.issue_to_vehicle', 'vehicles.manage', 'inventory.view_all_stock']);
  return loadReturns(getDb(), eq(vehicleReturns.vehicleId, filter.vehicleId));
}
