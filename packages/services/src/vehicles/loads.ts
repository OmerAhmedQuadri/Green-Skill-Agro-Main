import {
  allocateFefo, ceilingCheck, dec, DomainError, HOLDING_LOAD_STATUSES, packCount, toBaseUnits, toMoney, transitionLoad,
  type BatchId, type Leg, type LoadStatus, type Money, type Quantity, type SkuId,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { aliasedTable, and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { sellerVehicleAccount } from '../attendance';
import { sizeOf } from '../catalogue';
import { authorize, authorizeAny, type Ctx } from '../context';
import { availableOf, batchRefs, computeExpiryFlags, postStockMovements, warehouseAccount } from '../inventory';
import { notify } from '../notifications';
import { audit, inTx, nextDocumentNumber, type Executor, type Tx } from '../platform';
import { getDb } from '../runtime';
import { effectiveCeiling } from '../system';
import { basePrices, unitsOf, valueOf, vehicleBatches } from './stock';

const { vehicles, vehicleLoadouts, vehicleLoadoutLines, vehicleHandovers, batches, skus, products, stockMovements, users } = schema;

type Named = { readonly nameEn: string; readonly nameAr: string };

// ---------------------------------------------------------------- proposal (VEH-005)

export type ProposedBatch = {
  readonly batchId: BatchId; readonly lotNumber: string | null; readonly expiresOn: string | null; readonly flagged: boolean;
  readonly availablePacks: number; readonly packs: number;
};
export type LoadProposal = {
  readonly skuId: SkuId; readonly code: string; readonly product: Named; readonly requestedPacks: number;
  readonly unitPrice: Money | null; readonly shortfallPacks: number;
  /** Every warehouse batch with stock, in FEFO order — flagged first; `packs` is the proposal. */
  readonly batches: readonly ProposedBatch[];
};

/**
 * VEH-005: for each SKU and quantity, the warehouse batches to take, first
 * expiry first out with flagged batches on top (EXP-006). Advisory — the
 * manager may pick other batches (DATA-MODEL §5.4).
 */
export async function proposeLoad(ctx: Ctx, input: { lines: readonly { skuId: string; packs: number }[] }): Promise<LoadProposal[]> {
  authorize(ctx, 'inventory.issue_to_vehicle');
  const db = getDb();
  const warehouse = await warehouseAccount(db);
  const skuIds = input.lines.map((l) => l.skuId);
  if (skuIds.length === 0) return [];
  const held = sql<string>`sum(${stockMovements.quantity})`;
  const rows = await db.select({ batch: batches, sku: skus, productEn: products.nameEn, productAr: products.nameAr, held }).from(stockMovements)
    .innerJoin(batches, eq(batches.id, stockMovements.batchId)).innerJoin(skus, eq(skus.id, batches.skuId)).innerJoin(products, eq(products.id, skus.productId))
    .where(and(eq(stockMovements.accountKind, 'WAREHOUSE'), eq(stockMovements.warehouseId, warehouse.warehouseId), inArray(skus.id, skuIds)))
    .groupBy(batches.id, skus.id, products.id).having(sql`${held} > 0`);
  const [flags, prices, skuRows] = await Promise.all([
    computeExpiryFlags(ctx.now, rows.map((r) => r.batch.id)),
    basePrices(db, skuIds),
    db.select({ sku: skus, productEn: products.nameEn, productAr: products.nameAr }).from(skus).innerJoin(products, eq(products.id, skus.productId)).where(inArray(skus.id, skuIds)),
  ]);
  const flagged = new Set(flags.filter((f) => f.time || f.rate.flagged || f.prioritised).map((f) => f.batchId as string));

  const out: LoadProposal[] = [];
  for (const line of input.lines) {
    const skuRow = skuRows.find((s) => s.sku.id === line.skuId);
    if (!skuRow) throw new DomainError('NOT_FOUND', { entity: 'sku', id: line.skuId });
    const units = unitsOf(sizeOf(skuRow.sku));
    const size = dec(toBaseUnits(packCount(1), units));
    const candidates = [];
    for (const r of rows.filter((x) => x.sku.id === line.skuId)) {
      const available = await availableOf(db, r.batch.id, warehouse);
      const availablePacks = available.div(size).floor().toNumber();
      if (availablePacks > 0) candidates.push({ r, availablePacks });
    }
    // Allocation counts in packs here: a load moves whole packs.
    const allocation = allocateFefo(String(line.packs) as Quantity, candidates.map((c) => ({
      batchId: c.r.batch.id, expiresOn: c.r.batch.expiresOn, receivedAt: c.r.batch.firstReceivedAt,
      available: String(c.availablePacks) as Quantity, flagged: flagged.has(c.r.batch.id),
    })));
    const taken = new Map(allocation.allocations.map((a) => [a.batchId, dec(a.quantity).toNumber()]));
    const ordered = [...candidates].sort((a, b) => {
      const fa = flagged.has(a.r.batch.id), fb = flagged.has(b.r.batch.id);
      if (fa !== fb) return fa ? -1 : 1;
      const ea = a.r.batch.expiresOn ?? '9999-12-31', eb = b.r.batch.expiresOn ?? '9999-12-31';
      return ea === eb ? a.r.batch.firstReceivedAt.getTime() - b.r.batch.firstReceivedAt.getTime() : ea < eb ? -1 : 1;
    });
    out.push({
      skuId: line.skuId as SkuId, code: skuRow.sku.code, product: { nameEn: skuRow.productEn, nameAr: skuRow.productAr }, requestedPacks: line.packs,
      unitPrice: prices.get(line.skuId) ?? null,
      shortfallPacks: allocation.kind === 'SHORTFALL' ? dec(allocation.shortfall).toNumber() : 0,
      batches: ordered.map((c) => ({
        batchId: c.r.batch.id as BatchId, lotNumber: c.r.batch.lotNumber, expiresOn: c.r.batch.expiresOn, flagged: flagged.has(c.r.batch.id),
        availablePacks: c.availablePacks, packs: taken.get(c.r.batch.id) ?? 0,
      })),
    });
  }
  return out;
}

// ---------------------------------------------------------------- the load (STATE-MACHINES §7)

export type Load = {
  readonly id: string; readonly number: string; readonly status: LoadStatus;
  readonly vehicle: { readonly id: string; readonly registration: string };
  readonly seller: { readonly id: string; readonly name: string };
  readonly issuedAt: Date; readonly issuedBy: string;
  readonly confirmedAt: Date | null; readonly disputedAt: Date | null; readonly disputeComment: string | null;
  readonly cancelledAt: Date | null; readonly cancelReason: string | null;
  readonly loadValue: Money; readonly vehicleValue: Money; readonly ceiling: Money | null; readonly ceilingAcknowledged: boolean;
  readonly lines: readonly {
    readonly batchId: BatchId; readonly skuId: SkuId; readonly code: string; readonly product: Named;
    readonly lotNumber: string | null; readonly expiresOn: string | null; readonly packs: number; readonly unitPrice: Money | null; readonly disputeNote: string | null;
  }[];
  readonly version: number;
};

const issuer = aliasedTable(users, 'issuer');

async function loadLoads(db: Executor, where: SQL | undefined, limit = 100): Promise<Load[]> {
  const rows = await db.select({ l: vehicleLoadouts, registration: vehicles.registration, seller: users.name, issuer: issuer.name })
    .from(vehicleLoadouts).innerJoin(vehicles, eq(vehicles.id, vehicleLoadouts.vehicleId))
    .innerJoin(users, eq(users.id, vehicleLoadouts.sellerId)).innerJoin(issuer, eq(issuer.id, vehicleLoadouts.issuedBy))
    .where(where).orderBy(desc(vehicleLoadouts.issuedAt), desc(vehicleLoadouts.id)).limit(limit);
  if (rows.length === 0) return [];
  const lines = await db.select({ line: vehicleLoadoutLines, batch: batches, sku: skus, productEn: products.nameEn, productAr: products.nameAr })
    .from(vehicleLoadoutLines).innerJoin(batches, eq(batches.id, vehicleLoadoutLines.batchId))
    .innerJoin(skus, eq(skus.id, batches.skuId)).innerJoin(products, eq(products.id, skus.productId))
    .where(inArray(vehicleLoadoutLines.loadoutId, rows.map((r) => r.l.id)))
    .orderBy(asc(skus.code), sql`${batches.expiresOn} asc nulls last`);
  return rows.map((r) => ({
    id: r.l.id, number: r.l.number, status: r.l.status, vehicle: { id: r.l.vehicleId, registration: r.registration },
    seller: { id: r.l.sellerId, name: r.seller }, issuedAt: r.l.issuedAt, issuedBy: r.issuer,
    confirmedAt: r.l.confirmedAt, disputedAt: r.l.disputedAt, disputeComment: r.l.disputeComment, cancelledAt: r.l.cancelledAt, cancelReason: r.l.cancelReason,
    loadValue: r.l.loadValue as Money, vehicleValue: r.l.vehicleValue as Money, ceiling: (r.l.ceiling ?? null) as Money | null, ceilingAcknowledged: r.l.ceilingAcknowledged,
    lines: lines.filter((x) => x.line.loadoutId === r.l.id).map((x) => ({
      batchId: x.batch.id as BatchId, skuId: x.sku.id as SkuId, code: x.sku.code, product: { nameEn: x.productEn, nameAr: x.productAr },
      lotNumber: x.batch.lotNumber, expiresOn: x.batch.expiresOn, packs: x.line.packs, unitPrice: (x.line.unitPrice ?? null) as Money | null, disputeNote: x.line.disputeNote,
    })),
    version: r.l.version,
  }));
}

async function loadOne(db: Executor, id: string): Promise<Load> {
  const [found] = await loadLoads(db, eq(vehicleLoadouts.id, id), 1);
  if (!found) throw new DomainError('NOT_FOUND', { entity: 'vehicle_load', id });
  return found;
}

type PreparedLine = { batchId: string; skuId: string; packs: number; quantity: Quantity; unitPrice: Money | null };

/** Whole packs of warehouse batches, each available after every other hold (DATA-MODEL §5.4a). */
async function prepareLines(tx: Tx, lines: readonly { batchId: string; packs: number }[], exceptLoadId?: string): Promise<PreparedLine[]> {
  if (lines.length === 0) throw new DomainError('EMPTY_LOAD');
  const ids = lines.map((l) => l.batchId);
  if (new Set(ids).size !== ids.length) throw new DomainError('DUPLICATE_SKU', { reason: 'DUPLICATE_BATCH' });
  for (const id of [...ids].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
  const warehouse = await warehouseAccount(tx);
  const rows = await tx.select({ batch: batches, sku: skus }).from(batches).innerJoin(skus, eq(skus.id, batches.skuId)).where(inArray(batches.id, ids));
  const prices = await basePrices(tx, rows.map((r) => r.sku.id));
  const out: PreparedLine[] = [];
  for (const line of lines) {
    const row = rows.find((r) => r.batch.id === line.batchId);
    if (!row) throw new DomainError('NOT_FOUND', { entity: 'batch', id: line.batchId });
    const quantity = toBaseUnits(packCount(line.packs), unitsOf(sizeOf(row.sku)));
    if (line.packs <= 0) throw new DomainError('INVALID_PACK_COUNT', { value: line.packs });
    const available = await availableOf(tx, line.batchId, warehouse, { loadId: exceptLoadId });
    if (available.lt(quantity)) throw new DomainError('INSUFFICIENT_STOCK', { batchId: line.batchId, code: row.sku.code, available: available.toString(), requested: quantity });
    out.push({ batchId: line.batchId, skuId: row.sku.id, packs: line.packs, quantity, unitPrice: prices.get(row.sku.id) ?? null });
  }
  return out;
}

/**
 * VEH-006: the vehicle's stock and its other waiting loads, plus this load,
 * against the seller's ceiling. Over it, the manager must acknowledge the
 * warning first — it never blocks (LIM-005).
 */
async function valuation(tx: Tx, vehicleId: string, sellerId: string, lines: readonly PreparedLine[], acknowledge: boolean, exceptLoadId?: string) {
  const loadValue = valueOf(lines);
  const onVehicle = valueOf(await vehicleBatches(tx, [vehicleId]));
  const [pending] = await tx.select({ v: sql<string>`coalesce(sum(${vehicleLoadouts.loadValue}), 0)` }).from(vehicleLoadouts)
    .where(and(eq(vehicleLoadouts.vehicleId, vehicleId), inArray(vehicleLoadouts.status, [...HOLDING_LOAD_STATUSES]), exceptLoadId ? ne(vehicleLoadouts.id, exceptLoadId) : undefined));
  const vehicleValue = toMoney(dec(onVehicle).plus(dec(pending?.v ?? '0')));
  const ceiling = await effectiveCeiling(tx, 'VEHICLE_STOCK_VALUE', sellerId);
  const check = ceilingCheck({ current: vehicleValue, load: loadValue, ceiling });
  if (check.breach && !acknowledge) {
    throw new DomainError('CEILING_WARNING', { loadValue, vehicleValue, projected: check.projected, ceiling, excess: check.excess });
  }
  const unpriced = lines.filter((l) => l.unitPrice === null).map((l) => l.skuId);
  return { loadValue, vehicleValue, ceiling, acknowledged: check.breach, unpriced };
}

async function insertLines(tx: Tx, loadoutId: string, lines: readonly PreparedLine[]) {
  await tx.insert(vehicleLoadoutLines).values(lines.map((l) => ({ loadoutId, batchId: l.batchId, packs: l.packs, quantity: l.quantity, unitPrice: l.unitPrice })));
}

/**
 * Workflow F steps 2–3 (VEH-005, 006): issue a load to a vehicle and its
 * assigned seller. Nothing moves yet; the quantities are held in the
 * warehouse until the seller confirms on their phone (VEH-007).
 */
export async function issueLoad(
  ctx: Ctx, input: { vehicleId: string; lines: readonly { batchId: string; packs: number }[]; acknowledgeCeiling?: boolean | undefined },
): Promise<Load> {
  authorize(ctx, 'inventory.issue_to_vehicle');
  return inTx(ctx, async (tx) => {
    const [vehicle] = await tx.select().from(vehicles).where(eq(vehicles.id, input.vehicleId)).for('update');
    if (!vehicle) throw new DomainError('NOT_FOUND', { entity: 'vehicle', id: input.vehicleId });
    if (vehicle.status !== 'ACTIVE') throw new DomainError('VEHICLE_INACTIVE', { status: vehicle.status });
    const [assignment] = await tx.select({ sellerId: schema.vehicleAssignments.sellerId }).from(schema.vehicleAssignments)
      .where(and(eq(schema.vehicleAssignments.vehicleId, vehicle.id), sql`${schema.vehicleAssignments.endedAt} is null`));
    if (!assignment) throw new DomainError('VEHICLE_NOT_ASSIGNED');
    const [handover] = await tx.select({ id: vehicleHandovers.id }).from(vehicleHandovers)
      .where(and(eq(vehicleHandovers.vehicleId, vehicle.id), eq(vehicleHandovers.status, 'PROPOSED')));
    if (handover) throw new DomainError('HANDOVER_PENDING');

    const lines = await prepareLines(tx, input.lines);
    const value = await valuation(tx, vehicle.id, assignment.sellerId, lines, input.acknowledgeCeiling === true);
    const number = await nextDocumentNumber(tx, 'VL', ctx.now);
    const warehouse = await warehouseAccount(tx);
    const [row] = await tx.insert(vehicleLoadouts).values({
      number, vehicleId: vehicle.id, sellerId: assignment.sellerId, warehouseId: warehouse.warehouseId, status: 'ISSUED',
      loadValue: value.loadValue, vehicleValue: value.vehicleValue, ceiling: value.ceiling, ceilingAcknowledged: value.acknowledged,
      issuedAt: ctx.now, issuedBy: ctx.user.id, branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: vehicleLoadouts.id });
    if (!row) throw new Error('load insert returned nothing');
    await insertLines(tx, row.id, lines);
    await notify(tx, ctx, { users: [assignment.sellerId] }, 'LOAD_ISSUED', { number, packs: lines.reduce((n, l) => n + l.packs, 0) }, '/field/vehicle');
    await audit(tx, ctx, {
      action: 'vehicles.load_issued', entityType: 'vehicle_load', entityId: row.id,
      after: { number, vehicleId: vehicle.id, sellerId: assignment.sellerId, lines, ...value },
    });
    return loadOne(tx, row.id);
  });
}

async function lockLoad(tx: Tx, id: string, version?: number) {
  const [row] = await tx.select().from(vehicleLoadouts).where(eq(vehicleLoadouts.id, id)).for('update');
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'vehicle_load', id });
  if (version !== undefined && row.version !== version) throw new DomainError('VERSION_CONFLICT', { entity: 'vehicle_load', id });
  return row;
}

/** VEH-007: a disputed load is corrected and issued again, or an issued one changed before confirmation. */
export async function amendLoad(
  ctx: Ctx, id: string, input: { version: number; lines: readonly { batchId: string; packs: number }[]; acknowledgeCeiling?: boolean | undefined },
): Promise<Load> {
  authorize(ctx, 'inventory.issue_to_vehicle');
  return inTx(ctx, async (tx) => {
    const current = await lockLoad(tx, id, input.version);
    const status = transitionLoad(current.status, 'amend');
    const lines = await prepareLines(tx, input.lines, id);
    const value = await valuation(tx, current.vehicleId, current.sellerId, lines, input.acknowledgeCeiling === true, id);
    await tx.delete(vehicleLoadoutLines).where(eq(vehicleLoadoutLines.loadoutId, id));
    await insertLines(tx, id, lines);
    await tx.update(vehicleLoadouts).set({
      status, loadValue: value.loadValue, vehicleValue: value.vehicleValue, ceiling: value.ceiling, ceilingAcknowledged: value.acknowledged,
      updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1,
    }).where(eq(vehicleLoadouts.id, id));
    await notify(tx, ctx, { users: [current.sellerId] }, 'LOAD_ISSUED', { number: current.number, packs: lines.reduce((n, l) => n + l.packs, 0), amended: 1 }, '/field/vehicle');
    await audit(tx, ctx, { action: 'vehicles.load_amended', entityType: 'vehicle_load', entityId: id, before: { status: current.status }, after: { lines, ...value } });
    return loadOne(tx, id);
  });
}

export async function cancelLoad(ctx: Ctx, id: string, input: { version: number; reason: string }): Promise<Load> {
  authorize(ctx, 'inventory.issue_to_vehicle');
  return inTx(ctx, async (tx) => {
    const current = await lockLoad(tx, id, input.version);
    const status = transitionLoad(current.status, 'cancel', input.reason);
    await tx.update(vehicleLoadouts).set({
      status, cancelledAt: ctx.now, cancelReason: input.reason.trim(), updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1,
    }).where(eq(vehicleLoadouts.id, id));
    await notify(tx, ctx, { users: [current.sellerId] }, 'LOAD_CANCELLED', { number: current.number }, '/field/vehicle');
    await audit(tx, ctx, { action: 'vehicles.load_cancelled', entityType: 'vehicle_load', entityId: id, after: { reason: input.reason.trim() } });
    return loadOne(tx, id);
  });
}

/** Only the seller the load was issued to acts on it; to anyone else it does not exist. */
async function ownLoad(tx: Tx, ctx: Ctx, id: string, version: number) {
  const current = await lockLoad(tx, id);
  if (current.sellerId !== ctx.user.id) throw new DomainError('NOT_FOUND', { entity: 'vehicle_load', id });
  if (current.version !== version) throw new DomainError('VERSION_CONFLICT', { entity: 'vehicle_load', id });
  return current;
}

/**
 * Workflow F steps 4–5 (VEH-007, 008): the seller confirms on their own phone,
 * during an OPEN day with that vehicle (ATT-010). Warehouse down, vehicle up,
 * total unchanged — one balanced group.
 */
export async function confirmLoad(ctx: Ctx, id: string, input: { version: number }): Promise<Load> {
  authorize(ctx, 'inventory.confirm_load');
  return inTx(ctx, async (tx) => {
    const current = await ownLoad(tx, ctx, id, input.version);
    const status = transitionLoad(current.status, 'confirm');
    const account = await sellerVehicleAccount(tx, ctx);
    if (account.vehicleId !== current.vehicleId) throw new DomainError('VEHICLE_NOT_ASSIGNED', { vehicleId: current.vehicleId });
    const lines = await tx.select().from(vehicleLoadoutLines).where(eq(vehicleLoadoutLines.loadoutId, id));
    const refs = await batchRefs(tx, lines.map((l) => l.batchId));
    const legs: Leg[] = lines.flatMap((l) => {
      const balanceKey = refs.get(l.batchId)?.balanceKey ?? l.batchId;
      return [
        { batchId: l.batchId, balanceKey, account: { kind: 'WAREHOUSE', warehouseId: current.warehouseId }, quantity: `-${l.quantity}` as Quantity },
        { batchId: l.batchId, balanceKey, account, quantity: l.quantity as Quantity },
      ];
    });
    const { groupId } = await postStockMovements(tx, ctx, { referenceType: 'VEHICLE_LOADOUT', referenceId: id, legs });
    await tx.update(vehicleLoadouts).set({
      status, confirmedAt: ctx.now, movementGroupId: groupId, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1,
    }).where(eq(vehicleLoadouts.id, id));
    await notify(tx, ctx, { users: [current.issuedBy] }, 'LOAD_CONFIRMED', { number: current.number }, `/console/vehicles/${current.vehicleId}`);
    await audit(tx, ctx, { action: 'vehicles.load_confirmed', entityType: 'vehicle_load', entityId: id, after: { groupId } });
    return loadOne(tx, id);
  });
}

/** VEH-007: the seller disputes — the other side of the two-sided record — with a comment, and per line if they wish. */
export async function disputeLoad(
  ctx: Ctx, id: string, input: { version: number; comment: string; lines?: readonly { batchId: string; note: string }[] | undefined },
): Promise<Load> {
  authorize(ctx, 'inventory.confirm_load');
  return inTx(ctx, async (tx) => {
    const current = await ownLoad(tx, ctx, id, input.version);
    const status = transitionLoad(current.status, 'dispute', input.comment);
    for (const line of input.lines ?? []) {
      const note = line.note.trim();
      if (note) await tx.update(vehicleLoadoutLines).set({ disputeNote: note }).where(and(eq(vehicleLoadoutLines.loadoutId, id), eq(vehicleLoadoutLines.batchId, line.batchId)));
    }
    await tx.update(vehicleLoadouts).set({
      status, disputedAt: ctx.now, disputeComment: input.comment.trim(), updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1,
    }).where(eq(vehicleLoadouts.id, id));
    await notify(tx, ctx, { users: [current.issuedBy] }, 'LOAD_DISPUTED', { number: current.number }, `/console/vehicles/${current.vehicleId}`);
    await audit(tx, ctx, { action: 'vehicles.load_disputed', entityType: 'vehicle_load', entityId: id, after: { comment: input.comment.trim(), lines: input.lines ?? [] } });
    return loadOne(tx, id);
  });
}

/** Issuers see every load; a seller sees the loads issued to them. */
export async function listLoads(
  ctx: Ctx, filter: { status?: LoadStatus | undefined; vehicleId?: string | undefined; open?: boolean | undefined } = {},
): Promise<Load[]> {
  authorizeAny(ctx, ['inventory.issue_to_vehicle', 'inventory.confirm_load']);
  const where: SQL[] = [];
  if (filter.status) where.push(eq(vehicleLoadouts.status, filter.status));
  if (filter.open) where.push(inArray(vehicleLoadouts.status, [...HOLDING_LOAD_STATUSES]));
  if (filter.vehicleId) where.push(eq(vehicleLoadouts.vehicleId, filter.vehicleId));
  if (!ctx.permissions.has('inventory.issue_to_vehicle')) where.push(eq(vehicleLoadouts.sellerId, ctx.user.id));
  return loadLoads(getDb(), and(...where));
}

export async function getLoad(ctx: Ctx, id: string): Promise<Load> {
  authorizeAny(ctx, ['inventory.issue_to_vehicle', 'inventory.confirm_load']);
  const found = await loadOne(getDb(), id);
  if (!ctx.permissions.has('inventory.issue_to_vehicle') && found.seller.id !== ctx.user.id) throw new DomainError('NOT_FOUND', { entity: 'vehicle_load', id });
  return found;
}

