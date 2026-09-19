import { dec, HOLDING_LOAD_STATUSES, HOLDING_SALE_STATUSES, type StockAccount } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../platform';
import { positionOf } from './ledger';

const { writeOffs, vehicleLoadouts, vehicleLoadoutLines, sales, saleLines, saleLineAllocations } = schema;

export type HoldExceptions = { readonly writeOffId?: string | undefined; readonly loadId?: string | undefined; readonly saleId?: string | undefined };

/**
 * Holds are derived, never posted (DATA-MODEL §5.4a). A submitted write-off
 * holds its quantity where it sits (ADR-0029); a vehicle load the seller has
 * not confirmed holds warehouse stock (VEH-007); a sale awaiting a discount
 * decision holds its batches on the vehicle (PRC-011, ADR-0037).
 */
export async function heldQuantity(db: Executor, batchId: string, account: StockAccount, except: HoldExceptions = {}): Promise<string> {
  const where: SQL[] = [eq(writeOffs.batchId, batchId), eq(writeOffs.status, 'SUBMITTED'), eq(writeOffs.accountKind, account.kind)];
  where.push(account.kind === 'WAREHOUSE' ? eq(writeOffs.warehouseId, account.warehouseId) : isNull(writeOffs.warehouseId));
  where.push(account.kind === 'VEHICLE' ? eq(writeOffs.vehicleId, account.vehicleId) : isNull(writeOffs.vehicleId));
  if (except.writeOffId) where.push(ne(writeOffs.id, except.writeOffId));
  const [writeOffHeld] = await db.select({ q: sql<string>`coalesce(sum(${writeOffs.requestedQuantity}), 0)` }).from(writeOffs).where(and(...where));
  let held = dec(writeOffHeld?.q ?? '0');
  if (account.kind === 'WAREHOUSE') {
    const [loadHeld] = await db.select({ q: sql<string>`coalesce(sum(${vehicleLoadoutLines.quantity}), 0)` })
      .from(vehicleLoadoutLines).innerJoin(vehicleLoadouts, eq(vehicleLoadouts.id, vehicleLoadoutLines.loadoutId))
      .where(and(
        eq(vehicleLoadoutLines.batchId, batchId), eq(vehicleLoadouts.warehouseId, account.warehouseId),
        inArray(vehicleLoadouts.status, [...HOLDING_LOAD_STATUSES]), except.loadId ? ne(vehicleLoadouts.id, except.loadId) : undefined,
      ));
    held = held.plus(dec(loadHeld?.q ?? '0'));
  }
  if (account.kind === 'VEHICLE') held = held.plus(dec(await saleHeld(db, batchId, account.vehicleId, except.saleId)));
  return held.toFixed(3);
}

/** What can be taken from an account now: its position less its holds. */
export async function availableOf(db: Executor, batchId: string, account: StockAccount, except: HoldExceptions = {}) {
  // One after the other: `db` is usually a transaction — a single connection.
  const position = await positionOf(db, batchId, account);
  const held = await heldQuantity(db, batchId, account, except);
  return dec(position).minus(dec(held));
}

/** PRC-011: what sales awaiting a decision hold of one batch on one vehicle. */
export async function saleHeld(db: Executor, batchId: string, vehicleId: string, exceptSaleId?: string): Promise<string> {
  const [row] = await db.select({ q: sql<string>`coalesce(sum(${saleLineAllocations.quantity}), 0)` })
    .from(saleLineAllocations).innerJoin(saleLines, eq(saleLines.id, saleLineAllocations.saleLineId)).innerJoin(sales, eq(sales.id, saleLines.saleId))
    .where(and(
      eq(saleLineAllocations.batchId, batchId), eq(sales.vehicleId, vehicleId), inArray(sales.status, [...HOLDING_SALE_STATUSES]),
      exceptSaleId ? ne(sales.id, exceptSaleId) : undefined,
    ));
  return row?.q ?? '0';
}

/** Every batch's sale holds on the given vehicles, for listing vehicle stock. */
export async function saleHoldsByBatch(db: Executor, vehicleIds: readonly string[]): Promise<{ vehicleId: string; batchId: string; q: string }[]> {
  if (vehicleIds.length === 0) return [];
  // Vehicle sales only: the filter below keeps the vehicle id non-null.
  return db.select({ vehicleId: sql<string>`${sales.vehicleId}`, batchId: saleLineAllocations.batchId, q: sql<string>`sum(${saleLineAllocations.quantity})` })
    .from(saleLineAllocations).innerJoin(saleLines, eq(saleLines.id, saleLineAllocations.saleLineId)).innerJoin(sales, eq(sales.id, saleLines.saleId))
    .where(and(inArray(sales.vehicleId, [...vehicleIds]), inArray(sales.status, [...HOLDING_SALE_STATUSES])))
    .groupBy(sales.vehicleId, saleLineAllocations.batchId);
}
