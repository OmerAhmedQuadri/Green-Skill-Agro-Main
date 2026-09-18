import {
  assertBalanced, DomainError, dec, type Leg, type StockAccount, type StockReferenceType,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { Executor } from '../platform';

const { stockMovements, batches, skus } = schema;

const accountColumns = (account: StockAccount) => ({
  accountKind: account.kind,
  warehouseId: account.kind === 'WAREHOUSE' ? account.warehouseId : null,
  vehicleId: account.kind === 'VEHICLE' ? account.vehicleId : null,
});
const accountKey = (batchId: string, a: StockAccount) =>
  `${batchId}|${a.kind}|${a.kind === 'WAREHOUSE' ? a.warehouseId : ''}|${a.kind === 'VEHICLE' ? a.vehicleId : ''}`;

/** A batch's position in one account, in base units. */
export async function positionOf(db: Executor, batchId: string, account: StockAccount): Promise<string> {
  const c = accountColumns(account);
  const where: SQL[] = [eq(stockMovements.batchId, batchId), eq(stockMovements.accountKind, c.accountKind)];
  where.push(c.warehouseId ? eq(stockMovements.warehouseId, c.warehouseId) : isNull(stockMovements.warehouseId));
  where.push(c.vehicleId ? eq(stockMovements.vehicleId, c.vehicleId) : isNull(stockMovements.vehicleId));
  const [row] = await db.select({ q: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)` }).from(stockMovements).where(and(...where));
  return row?.q ?? '0';
}

/**
 * The one way stock changes (ADR-0001, STK-013). Posts a balanced group of
 * legs in the caller's transaction. Batches are locked in id order first, so
 * two postings against one batch run one after the other and a position can
 * never be spent twice; the database re-checks everything at commit.
 */
export async function postStockMovements(
  tx: Executor, ctx: Ctx,
  posting: { referenceType: StockReferenceType; referenceId: string; occurredAt?: Date; legs: readonly Leg[] },
): Promise<{ groupId: string }> {
  assertBalanced(posting.legs, posting.referenceType === 'SKU_CONVERSION' ? 'PER_VARIETY' : 'PER_BATCH');
  const batchIds = [...new Set(posting.legs.map((l) => l.batchId))].sort();
  for (const id of batchIds) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);

  // Net change per account, checked against what is there now. Internal
  // accounts and the SOLD and WRITTEN_OFF sinks never go below zero — a return
  // cannot un-sell more than was sold; SUPPLIER, the source, never goes above it.
  const net = new Map<string, { batchId: string; account: StockAccount; change: ReturnType<typeof dec> }>();
  for (const leg of posting.legs) {
    const key = accountKey(leg.batchId, leg.account);
    const entry = net.get(key) ?? { batchId: leg.batchId, account: leg.account, change: dec('0') };
    entry.change = entry.change.plus(dec(leg.quantity));
    net.set(key, entry);
  }
  for (const { batchId, account, change } of net.values()) {
    const source = account.kind === 'SUPPLIER';
    if (source ? !change.isPositive() || change.isZero() : !change.isNegative()) continue;
    const held = dec(await positionOf(tx, batchId, account));
    const after = held.plus(change);
    if (source ? after.isPositive() && !after.isZero() : after.isNegative()) {
      throw new DomainError('INSUFFICIENT_STOCK', { batchId, account: account.kind, held: held.toString(), requested: change.negated().toString() });
    }
  }

  const groupId = newId();
  await tx.insert(stockMovements).values(posting.legs.map((leg) => ({
    groupId, occurredAt: posting.occurredAt ?? ctx.now, batchId: leg.batchId, quantity: leg.quantity,
    ...accountColumns(leg.account), referenceType: posting.referenceType, referenceId: posting.referenceId,
    branchId: ctx.branchId, createdBy: ctx.user.id,
  })));
  return { groupId };
}

export type BatchRef = { id: string; balanceKey: string };

/**
 * STK-001/002: the batch for SKU + LOT + MFD + expiry, created on first
 * receipt. A repeat consignment of the same LOT and dates adds to it.
 */
export async function findOrCreateBatch(
  tx: Executor, ctx: Ctx,
  input: { skuId: string; lotNumber: string | null; manufacturedOn: string | null; expiresOn: string | null; receivedAt: Date },
): Promise<BatchRef> {
  await tx.insert(batches).values({
    skuId: input.skuId, lotNumber: input.lotNumber, manufacturedOn: input.manufacturedOn, expiresOn: input.expiresOn,
    firstReceivedAt: input.receivedAt, branchId: ctx.branchId, createdBy: ctx.user.id,
  }).onConflictDoNothing({ target: [batches.skuId, batches.lotNumber, batches.manufacturedOn, batches.expiresOn] });
  const same = (col: typeof batches.lotNumber | typeof batches.manufacturedOn | typeof batches.expiresOn, value: string | null) =>
    (value === null ? isNull(col) : eq(col, value));
  const [row] = await tx.select({ id: batches.id, varietyId: skus.varietyId, productId: skus.productId })
    .from(batches).innerJoin(skus, eq(skus.id, batches.skuId))
    .where(and(eq(batches.skuId, input.skuId), same(batches.lotNumber, input.lotNumber), same(batches.manufacturedOn, input.manufacturedOn), same(batches.expiresOn, input.expiresOn)));
  if (!row) throw new Error('batch missing after insert');
  return { id: row.id, balanceKey: row.varietyId ?? row.productId };
}

export async function batchRefs(db: Executor, ids: readonly string[]): Promise<Map<string, BatchRef>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: batches.id, varietyId: skus.varietyId, productId: skus.productId })
    .from(batches).innerJoin(skus, eq(skus.id, batches.skuId)).where(inArray(batches.id, [...ids]));
  return new Map(rows.map((r) => [r.id, { id: r.id, balanceKey: r.varietyId ?? r.productId }]));
}
