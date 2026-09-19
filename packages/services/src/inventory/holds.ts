import { dec, type StockAccount } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../platform';
import { positionOf } from './ledger';

const { writeOffs } = schema;

/**
 * Holds are derived, never posted (DATA-MODEL §5.4a). A submitted write-off
 * holds its quantity: damaged stock waiting for a decision is not issued,
 * sold or converted meanwhile (ADR-0029). Later sources — pending discount
 * approvals, unconfirmed vehicle loads — join here.
 */
export async function heldQuantity(db: Executor, batchId: string, account: StockAccount, exceptWriteOffId?: string): Promise<string> {
  const where: SQL[] = [eq(writeOffs.batchId, batchId), eq(writeOffs.status, 'SUBMITTED'), eq(writeOffs.accountKind, account.kind)];
  where.push(account.kind === 'WAREHOUSE' ? eq(writeOffs.warehouseId, account.warehouseId) : isNull(writeOffs.warehouseId));
  where.push(account.kind === 'VEHICLE' ? eq(writeOffs.vehicleId, account.vehicleId) : isNull(writeOffs.vehicleId));
  if (exceptWriteOffId) where.push(ne(writeOffs.id, exceptWriteOffId));
  const [row] = await db.select({ q: sql<string>`coalesce(sum(${writeOffs.requestedQuantity}), 0)` }).from(writeOffs).where(and(...where));
  return row?.q ?? '0';
}

/** What can be taken from an account now: its position less its holds. */
export async function availableOf(db: Executor, batchId: string, account: StockAccount, exceptWriteOffId?: string) {
  const [position, held] = await Promise.all([positionOf(db, batchId, account), heldQuantity(db, batchId, account, exceptWriteOffId)]);
  return dec(position).minus(dec(held));
}
