import { dec, HOLDING_LOAD_STATUSES, type StockAccount } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../platform';
import { positionOf } from './ledger';

const { writeOffs, vehicleLoadouts, vehicleLoadoutLines } = schema;

export type HoldExceptions = { readonly writeOffId?: string | undefined; readonly loadId?: string | undefined };

/**
 * Holds are derived, never posted (DATA-MODEL §5.4a). A submitted write-off
 * holds its quantity where it sits (ADR-0029); a vehicle load the seller has
 * not confirmed holds warehouse stock (VEH-007). Pending discount approvals
 * join here with sales.
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
  return held.toFixed(3);
}

/** What can be taken from an account now: its position less its holds. */
export async function availableOf(db: Executor, batchId: string, account: StockAccount, except: HoldExceptions = {}) {
  // One after the other: `db` is usually a transaction — a single connection.
  const position = await positionOf(db, batchId, account);
  const held = await heldQuantity(db, batchId, account, except);
  return dec(position).minus(dec(held));
}
