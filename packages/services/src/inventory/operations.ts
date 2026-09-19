import {
  DomainError, planConversion, SUBMITTABLE_REASONS, decideWriteOff as decide, toBaseUnits, packCount,
  type BatchId, type Leg, type Quantity, type SkuUnits, type StockAccount, type WriteOffReason, type WriteOffStatus,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, asc, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import { sellerVehicleAccount } from '../attendance';
import { sizeOf } from '../catalogue';
import { authorize, authorizeAny, type Ctx } from '../context';
import { assertOwnEvidence } from '../media';
import { audit, inTx, nextDocumentNumber, pageLimit, type Executor, type Tx } from '../platform';
import { listPriceLists, setPriceListItems } from '../pricing';
import { getDb } from '../runtime';
import { readToggles } from '../system';
import { availableOf } from './holds';
import { findOrCreateBatch, postStockMovements } from './ledger';

const { batches, skus, products, warehouses, skuConversions, writeOffs, users } = schema;

type BatchInfo = {
  id: string; skuId: string; code: string; productId: string; varietyId: string | null; units: SkuUnits;
  lotNumber: string | null; manufacturedOn: string | null; expiresOn: string | null; firstReceivedAt: Date; skuActive: boolean;
};

async function batchInfo(db: Executor, batchId: string): Promise<BatchInfo> {
  const [row] = await db.select({ batch: batches, sku: skus }).from(batches).innerJoin(skus, eq(skus.id, batches.skuId)).where(eq(batches.id, batchId));
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'batch', id: batchId });
  const size = sizeOf(row.sku);
  return {
    id: row.batch.id, skuId: row.sku.id, code: row.sku.code, productId: row.sku.productId, varietyId: row.sku.varietyId,
    units: size.measure === 'WEIGHT' ? { measure: 'WEIGHT', packWeightG: size.packWeightG } : { measure: 'COUNT', packCount: size.packCount },
    lotNumber: row.batch.lotNumber, manufacturedOn: row.batch.manufacturedOn, expiresOn: row.batch.expiresOn,
    firstReceivedAt: row.batch.firstReceivedAt, skuActive: row.sku.isActive,
  };
}

export async function warehouseAccount(db: Executor): Promise<StockAccount & { kind: 'WAREHOUSE' }> {
  const [w] = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.isActive, true)).orderBy(asc(warehouses.createdAt)).limit(1);
  if (!w) throw new Error('no active warehouse — run pnpm db:sync');
  return { kind: 'WAREHOUSE', warehouseId: w.id };
}

/**
 * Where a person may act on stock. Warehouse and management work on the
 * warehouse. A seller works only on their own vehicle, and converts only when
 * the Admin allows it (CNV-009) — WRO-001, CNV-009.
 */
async function accountFor(ctx: Ctx, db: Executor, feature: 'convert' | 'write_off'): Promise<StockAccount> {
  if (ctx.user.role === 'SELLER') {
    if (feature === 'convert' && !(await readToggles(db))['inventory.seller_conversion']) {
      throw new DomainError('FEATURE_DISABLED', { feature: 'inventory.seller_conversion' });
    }
    // ATT-010: only during an OPEN day, on the vehicle they checked in with.
    return sellerVehicleAccount(db, ctx);
  }
  return warehouseAccount(db);
}

const accountColumns = (a: StockAccount) => ({
  accountKind: a.kind, warehouseId: a.kind === 'WAREHOUSE' ? a.warehouseId : null, vehicleId: a.kind === 'VEHICLE' ? a.vehicleId : null,
});

/**
 * WRO-007, ADR-0039: goods that came back defective or unsaleable are
 * written off in the return's own transaction — already approved, linked to
 * the return, attributed to where they were (a store's goods: SOLD).
 */
export async function recordReturnWriteOff(
  tx: Tx, ctx: Ctx,
  input: { reason: 'DEFECTIVE' | 'EXPIRED' | 'DAMAGED' | 'MISSING'; batchId: string; packs: number; quantity: Quantity; returnId: string; movementGroupId: string; note: string | null },
): Promise<string> {
  const number = await nextDocumentNumber(tx, 'WO', ctx.now);
  await tx.insert(writeOffs).values({
    number, status: 'APPROVED', reason: input.reason, note: input.note, batchId: input.batchId, accountKind: 'SOLD', warehouseId: null, vehicleId: null,
    requestedPacks: input.packs, requestedQuantity: input.quantity, approvedQuantity: input.quantity, returnId: input.returnId,
    movementGroupId: input.movementGroupId, submittedAt: ctx.now, submittedBy: ctx.user.id, decidedAt: ctx.now, decidedBy: null,
    branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
  });
  return number;
}

// ---------------------------------------------------------------- conversion

export type ConversionRecord = {
  readonly id: string; readonly sourceBatchId: BatchId; readonly targetBatchId: BatchId; readonly sourceCode: string; readonly targetCode: string;
  readonly sourcePacks: number; readonly targetPacks: number; readonly lossQuantity: Quantity; readonly lotNumber: string | null;
  readonly reason: string; readonly performedAt: Date; readonly performedBy: string; readonly writeOffNumber: string | null;
};

/**
 * Workflow D (CNV-001..011): move stock from one SKU of a variety into
 * another, in one balanced group of three legs — −source, +target, +loss to
 * write-off (WRO-006). The target batch keeps the source's LOT, MFD and expiry
 * (CNV-006). A reason is required; there is no approval step (CNV-007, 008).
 */
export async function convertStock(
  ctx: Ctx,
  input: {
    sourceBatchId: string; targetSkuId: string; reason: string;
    sourcePacks?: number | null | undefined; targetPacks?: number | null | undefined; loss?: string | null | undefined;
    targetBasePrice?: string | null | undefined;
  },
): Promise<ConversionRecord> {
  authorize(ctx, 'inventory.convert');
  const reason = input.reason.trim();
  if (!reason) throw new DomainError('REASON_REQUIRED', { action: 'convert' });
  return inTx(ctx, async (tx) => {
    const account = await accountFor(ctx, tx, 'convert');
    const source = await batchInfo(tx, input.sourceBatchId);
    const [targetSku] = await tx.select().from(skus).where(eq(skus.id, input.targetSkuId));
    if (!targetSku) throw new DomainError('NOT_FOUND', { entity: 'sku', id: input.targetSkuId });
    if (!targetSku.isActive) throw new DomainError('REFERENCE_INACTIVE', { entity: 'sku', id: input.targetSkuId });
    const targetSize = sizeOf(targetSku);
    const plan = planConversion(
      { skuId: source.skuId, productId: source.productId, varietyId: source.varietyId, units: source.units },
      { skuId: targetSku.id, productId: targetSku.productId, varietyId: targetSku.varietyId,
        units: targetSize.measure === 'WEIGHT' ? { measure: 'WEIGHT', packWeightG: targetSize.packWeightG } : { measure: 'COUNT', packCount: targetSize.packCount } },
      { sourcePacks: input.sourcePacks, targetPacks: input.targetPacks, loss: input.loss },
    );

    const available = await availableOf(tx, source.id, account);
    if (available.lt(plan.sourceQuantity)) {
      throw new DomainError('INSUFFICIENT_STOCK', { batchId: source.id, available: available.toString(), requested: plan.sourceQuantity });
    }
    // CNV-006: repackaging alters the pack, not the goods.
    const target = await findOrCreateBatch(tx, ctx, {
      skuId: targetSku.id, lotNumber: source.lotNumber, manufacturedOn: source.manufacturedOn, expiresOn: source.expiresOn, receivedAt: source.firstReceivedAt,
    });
    const balanceKey = source.varietyId ?? source.productId;
    const legs: Leg[] = [
      { batchId: source.id, balanceKey, account, quantity: `-${plan.sourceQuantity}` as Quantity },
      { batchId: target.id, balanceKey, account, quantity: plan.targetQuantity },
      ...(plan.loss !== '0.000' ? [{ batchId: source.id, balanceKey, account: { kind: 'WRITTEN_OFF' } as const, quantity: plan.loss }] : []),
    ];
    const conversionId = newId();
    const { groupId } = await postStockMovements(tx, ctx, { referenceType: 'SKU_CONVERSION', referenceId: conversionId, legs });
    await tx.insert(skuConversions).values({
      id: conversionId, sourceBatchId: source.id, targetBatchId: target.id, ...accountColumns(account),
      sourcePacks: plan.sourcePacks, targetPacks: plan.targetPacks, sourceQuantity: plan.sourceQuantity, targetQuantity: plan.targetQuantity,
      lossQuantity: plan.loss, reason, movementGroupId: groupId, branchId: ctx.branchId, performedAt: ctx.now, performedBy: ctx.user.id,
    });

    // WRO-006: the loss is a write-off, already approved — it posted with the conversion.
    let writeOffNumber: string | null = null;
    if (plan.loss !== '0.000') {
      writeOffNumber = await nextDocumentNumber(tx, 'WO', ctx.now);
      await tx.insert(writeOffs).values({
        number: writeOffNumber, status: 'APPROVED', reason: 'CONVERSION_LOSS', note: reason, batchId: source.id, ...accountColumns(account),
        requestedPacks: null, requestedQuantity: plan.loss, approvedQuantity: plan.loss, conversionId, movementGroupId: groupId,
        submittedAt: ctx.now, submittedBy: ctx.user.id, decidedAt: ctx.now, decidedBy: null, branchId: ctx.branchId,
        createdBy: ctx.user.id, updatedBy: ctx.user.id,
      });
    }

    // CNV-004: the target's price may be set as part of the conversion.
    if (input.targetBasePrice?.trim()) {
      const joined = { ...ctx, tx };
      const base = (await listPriceLists(joined)).find((l) => l.isBase);
      if (!base) throw new Error('no base price list — run pnpm db:sync');
      await setPriceListItems(joined, base.id, [{ skuId: targetSku.id, price: input.targetBasePrice.trim() }]);
    }

    await audit(tx, ctx, {
      action: 'inventory.sku_converted', entityType: 'sku_conversion', entityId: conversionId,
      after: { sourceBatchId: source.id, targetBatchId: target.id, ...plan, reason, account: account.kind },
    });
    const [performer] = await tx.select({ name: users.name }).from(users).where(eq(users.id, ctx.user.id));
    return {
      id: conversionId, sourceBatchId: source.id as BatchId, targetBatchId: target.id as BatchId, sourceCode: source.code, targetCode: targetSku.code,
      sourcePacks: plan.sourcePacks, targetPacks: plan.targetPacks, lossQuantity: plan.loss, lotNumber: source.lotNumber,
      reason, performedAt: ctx.now, performedBy: performer?.name ?? '', writeOffNumber,
    };
  });
}

/** CNV-007: who converted what, when and why. */
export async function listConversions(ctx: Ctx, filter: { cursor?: string | undefined; limit?: number | undefined } = {}): Promise<{ items: ConversionRecord[]; nextCursor: string | null }> {
  authorizeAny(ctx, ['inventory.view_all_stock', 'inventory.convert']);
  const limit = pageLimit(filter.limit);
  const source = schema.batches;
  const rows = await getDb().select({
    c: skuConversions, performer: users.name,
    sourceCode: sql<string>`(select code from ${skus} where ${skus.id} = (select sku_id from ${batches} where ${batches.id} = ${skuConversions.sourceBatchId}))`,
    targetCode: sql<string>`(select code from ${skus} where ${skus.id} = (select sku_id from ${batches} where ${batches.id} = ${skuConversions.targetBatchId}))`,
    lotNumber: source.lotNumber,
    writeOffNumber: sql<string | null>`(select number from ${writeOffs} where ${writeOffs.conversionId} = ${skuConversions.id})`,
  }).from(skuConversions)
    .innerJoin(users, eq(users.id, skuConversions.performedBy))
    .innerJoin(source, eq(source.id, skuConversions.sourceBatchId))
    .where(filter.cursor ? lt(skuConversions.id, filter.cursor) : undefined)
    .orderBy(desc(skuConversions.id)).limit(limit + 1);
  const page = rows.slice(0, limit).map((r) => ({
    id: r.c.id, sourceBatchId: r.c.sourceBatchId as BatchId, targetBatchId: r.c.targetBatchId as BatchId, sourceCode: r.sourceCode, targetCode: r.targetCode,
    sourcePacks: r.c.sourcePacks, targetPacks: r.c.targetPacks, lossQuantity: r.c.lossQuantity as Quantity, lotNumber: r.lotNumber,
    reason: r.c.reason, performedAt: r.c.performedAt, performedBy: r.performer, writeOffNumber: r.writeOffNumber,
  }));
  return { items: page, nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}

// ---------------------------------------------------------------- write-offs

export type WriteOff = {
  readonly id: string; readonly number: string; readonly status: WriteOffStatus; readonly reason: WriteOffReason; readonly note: string | null;
  readonly batchId: BatchId; readonly skuId: string; readonly code: string; readonly product: { readonly nameEn: string; readonly nameAr: string };
  readonly lotNumber: string | null; readonly expiresOn: string | null; readonly location: 'WAREHOUSE' | 'VEHICLE' | 'DISPATCHED' | 'SOLD' | 'SUPPLIER' | 'WRITTEN_OFF';
  readonly requestedPacks: number | null; readonly requestedQuantity: Quantity; readonly approvedQuantity: Quantity | null;
  readonly photoId: string | null; readonly conversionId: string | null;
  readonly submittedAt: Date; readonly submittedBy: { readonly id: string; readonly name: string };
  readonly decidedAt: Date | null; readonly decidedBy: string | null; readonly decisionComment: string | null; readonly version: number;
};

async function loadWriteOffs(db: Executor, where: SQL | undefined, limit: number, cursor?: string): Promise<WriteOff[]> {
  const decider = schema.users;
  const rows = await db.select({
    w: writeOffs, sku: skus, productEn: products.nameEn, productAr: products.nameAr, lot: batches.lotNumber, expiresOn: batches.expiresOn,
    submitter: sql<string>`(select name from ${users} where ${users.id} = ${writeOffs.submittedBy})`,
    decider: sql<string | null>`(select name from ${decider} where ${decider.id} = ${writeOffs.decidedBy})`,
  }).from(writeOffs)
    .innerJoin(batches, eq(batches.id, writeOffs.batchId)).innerJoin(skus, eq(skus.id, batches.skuId)).innerJoin(products, eq(products.id, skus.productId))
    .where(and(where, cursor ? lt(writeOffs.id, cursor) : undefined))
    .orderBy(desc(writeOffs.id)).limit(limit);
  return rows.map((r) => ({
    id: r.w.id, number: r.w.number, status: r.w.status, reason: r.w.reason, note: r.w.note, batchId: r.w.batchId as BatchId,
    skuId: r.sku.id, code: r.sku.code, product: { nameEn: r.productEn, nameAr: r.productAr }, lotNumber: r.lot, expiresOn: r.expiresOn,
    location: r.w.accountKind, requestedPacks: r.w.requestedPacks, requestedQuantity: r.w.requestedQuantity as Quantity,
    approvedQuantity: (r.w.approvedQuantity ?? null) as Quantity | null, photoId: r.w.photoId, conversionId: r.w.conversionId,
    submittedAt: r.w.submittedAt, submittedBy: { id: r.w.submittedBy, name: r.submitter }, decidedAt: r.w.decidedAt, decidedBy: r.decider,
    decisionComment: r.w.decisionComment, version: r.w.version,
  }));
}

async function loadWriteOff(db: Executor, id: string): Promise<WriteOff> {
  const [found] = await loadWriteOffs(db, eq(writeOffs.id, id), 1);
  if (!found) throw new DomainError('NOT_FOUND', { entity: 'write_off', id });
  return found;
}

/**
 * Workflow E (WRO-001..003): report damaged, expired or missing stock with a
 * reason and a photograph. Nothing moves yet — the quantity is held until a
 * manager decides.
 */
export async function submitWriteOff(
  ctx: Ctx,
  input: { batchId: string; packs: number; reason: WriteOffReason; note?: string | null | undefined; photoId?: string | null | undefined },
): Promise<WriteOff> {
  authorize(ctx, 'inventory.submit_write_off');
  if (!SUBMITTABLE_REASONS.includes(input.reason)) throw new DomainError('INVALID_SETTING', { field: 'reason' });
  const note = input.note?.trim() || null;
  if (input.reason === 'OTHER' && !note) throw new DomainError('REASON_REQUIRED', { action: 'write_off' });
  if (!input.photoId) throw new DomainError('EVIDENCE_REQUIRED', { field: 'photoId' });
  const photoId = input.photoId;
  return inTx(ctx, async (tx) => {
    const account = await accountFor(ctx, tx, 'write_off');
    await assertOwnEvidence(tx, ctx, photoId, 'WRITE_OFF_EVIDENCE');
    const batch = await batchInfo(tx, input.batchId);
    const quantity = toBaseUnits(packCount(input.packs), batch.units);
    if (input.packs <= 0) throw new DomainError('INVALID_PACK_COUNT', { value: input.packs });
    const available = await availableOf(tx, batch.id, account);
    if (available.lt(quantity)) throw new DomainError('INSUFFICIENT_STOCK', { batchId: batch.id, available: available.toString(), requested: quantity });
    const number = await nextDocumentNumber(tx, 'WO', ctx.now);
    const [row] = await tx.insert(writeOffs).values({
      number, status: 'SUBMITTED', reason: input.reason, note, batchId: batch.id, ...accountColumns(account),
      requestedPacks: input.packs, requestedQuantity: quantity, photoId, submittedAt: ctx.now, submittedBy: ctx.user.id,
      branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: writeOffs.id });
    if (!row) throw new Error('write-off insert returned nothing');
    await audit(tx, ctx, { action: 'inventory.write_off_submitted', entityType: 'write_off', entityId: row.id, after: { number, batchId: batch.id, packs: input.packs, reason: input.reason, note } });
    return loadWriteOff(tx, row.id);
  });
}

/**
 * Workflow E (WRO-003..005): a different person approves — as submitted or
 * for fewer packs — or rejects with a comment. Approval moves the stock out of
 * the holding location into the write-off ledger, attributed to where it was.
 */
export async function decideWriteOffRequest(
  ctx: Ctx, id: string,
  input: { version: number; approve: boolean; approvedPacks?: number | null | undefined; comment?: string | null | undefined },
): Promise<WriteOff> {
  authorize(ctx, 'inventory.approve_write_off');
  return inTx(ctx, async (tx) => {
    const current = await loadWriteOff(tx, id);
    const [raw] = await tx.select().from(writeOffs).where(eq(writeOffs.id, id)).for('update');
    if (!raw) throw new DomainError('NOT_FOUND', { entity: 'write_off', id });
    if (raw.version !== input.version) throw new DomainError('VERSION_CONFLICT', { entity: 'write_off', id });
    const outcome = decide({ status: raw.status, submittedBy: raw.submittedBy, requestedPacks: raw.requestedPacks ?? 0 }, input, ctx.user.id);
    let approvedQuantity: string | null = null;
    let groupId: string | null = null;
    if (outcome.status === 'APPROVED' && outcome.approvedPacks !== null) {
      const batch = await batchInfo(tx, raw.batchId);
      approvedQuantity = toBaseUnits(packCount(outcome.approvedPacks), batch.units);
      const account: StockAccount = raw.accountKind === 'WAREHOUSE' && raw.warehouseId ? { kind: 'WAREHOUSE', warehouseId: raw.warehouseId }
        : raw.accountKind === 'VEHICLE' && raw.vehicleId ? { kind: 'VEHICLE', vehicleId: raw.vehicleId } : { kind: 'DISPATCHED' };
      const balanceKey = batch.varietyId ?? batch.productId;
      ({ groupId } = await postStockMovements(tx, ctx, {
        referenceType: 'WRITE_OFF', referenceId: id,
        legs: [
          { batchId: batch.id, balanceKey, account, quantity: `-${approvedQuantity}` as Quantity },
          { batchId: batch.id, balanceKey, account: { kind: 'WRITTEN_OFF' }, quantity: approvedQuantity as Quantity },
        ],
      }));
    }
    await tx.update(writeOffs).set({
      status: outcome.status, approvedQuantity, movementGroupId: groupId, decidedAt: ctx.now, decidedBy: ctx.user.id,
      decisionComment: input.comment?.trim() || null, updatedAt: ctx.now, updatedBy: ctx.user.id, version: raw.version + 1,
    }).where(and(eq(writeOffs.id, id), eq(writeOffs.version, input.version)));
    await audit(tx, ctx, {
      action: outcome.status === 'APPROVED' ? 'inventory.write_off_approved' : 'inventory.write_off_rejected', entityType: 'write_off', entityId: id,
      before: { status: current.status, requestedPacks: current.requestedPacks },
      after: { status: outcome.status, approvedPacks: outcome.approvedPacks, comment: input.comment ?? null },
    });
    return loadWriteOff(tx, id);
  });
}

/** Approvers see every write-off; a submitter sees their own. */
export async function listWriteOffs(
  ctx: Ctx, filter: { status?: WriteOffStatus | undefined; cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: WriteOff[]; nextCursor: string | null }> {
  authorizeAny(ctx, ['inventory.approve_write_off', 'inventory.submit_write_off']);
  const limit = pageLimit(filter.limit);
  const where: SQL[] = [];
  if (filter.status) where.push(eq(writeOffs.status, filter.status));
  if (!ctx.permissions.has('inventory.approve_write_off')) where.push(eq(writeOffs.submittedBy, ctx.user.id));
  const items = await loadWriteOffs(getDb(), and(...where), limit + 1, filter.cursor);
  const page = items.slice(0, limit);
  return { items: page, nextCursor: items.length > limit ? (page.at(-1)?.id ?? null) : null };
}

export async function getWriteOff(ctx: Ctx, id: string): Promise<WriteOff> {
  authorizeAny(ctx, ['inventory.approve_write_off', 'inventory.submit_write_off']);
  const found = await loadWriteOff(getDb(), id);
  if (!ctx.permissions.has('inventory.approve_write_off') && found.submittedBy.id !== ctx.user.id) throw new DomainError('NOT_FOUND', { entity: 'write_off', id });
  return found;
}
