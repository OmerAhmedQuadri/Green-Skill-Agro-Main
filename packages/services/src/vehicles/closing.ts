import { compareClosing, DomainError, type ClosingStatus, type SkuId } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, desc, eq, gte, inArray, lte, type SQL } from 'drizzle-orm';
import { liveSession, sellerVehicleAccount } from '../attendance';
import { authorize, authorizeAny, type Ctx } from '../context';
import { notify } from '../notifications';
import { audit, inTx, mapUniqueViolations, type Executor } from '../platform';
import { getDb } from '../runtime';
import { vehicleBatches } from './stock';

const { closingStockDeclarations, closingStockLines, skus, products, users, vehicles } = schema;

export type ClosingDeclaration = {
  readonly id: string; readonly workDate: string; readonly status: ClosingStatus;
  readonly seller: { readonly id: string; readonly name: string }; readonly vehicle: { readonly id: string; readonly registration: string };
  readonly declaredAt: Date; readonly reviewedAt: Date | null; readonly reviewedBy: string | null; readonly reviewComment: string | null;
  readonly lines: readonly {
    readonly skuId: SkuId; readonly code: string; readonly product: { readonly nameEn: string; readonly nameAr: string };
    readonly declaredPacks: number; readonly systemPacks: number; readonly variancePacks: number;
  }[];
  readonly version: number;
};

async function loadDeclarations(db: Executor, where: SQL | undefined): Promise<ClosingDeclaration[]> {
  const rows = await db.select({ d: closingStockDeclarations, seller: users.name, registration: vehicles.registration }).from(closingStockDeclarations)
    .innerJoin(users, eq(users.id, closingStockDeclarations.sellerId)).innerJoin(vehicles, eq(vehicles.id, closingStockDeclarations.vehicleId))
    .where(where).orderBy(desc(closingStockDeclarations.workDate), asc(users.name)).limit(200);
  if (rows.length === 0) return [];
  const lines = await db.select({ line: closingStockLines, code: skus.code, productEn: products.nameEn, productAr: products.nameAr }).from(closingStockLines)
      .innerJoin(skus, eq(skus.id, closingStockLines.skuId)).innerJoin(products, eq(products.id, skus.productId))
      .where(inArray(closingStockLines.declarationId, rows.map((r) => r.d.id))).orderBy(asc(skus.code));
  const reviewers = await db.select({ id: users.id, name: users.name }).from(users)
    .where(inArray(users.id, rows.map((r) => r.d.reviewedBy).filter((x): x is string => x !== null)));
  return rows.map((r) => ({
    id: r.d.id, workDate: r.d.workDate, status: r.d.status, seller: { id: r.d.sellerId, name: r.seller },
    vehicle: { id: r.d.vehicleId, registration: r.registration }, declaredAt: r.d.declaredAt, reviewedAt: r.d.reviewedAt,
    reviewedBy: reviewers.find((x) => x.id === r.d.reviewedBy)?.name ?? null, reviewComment: r.d.reviewComment,
    lines: lines.filter((l) => l.line.declarationId === r.d.id).map((l) => ({
      skuId: l.line.skuId as SkuId, code: l.code, product: { nameEn: l.productEn, nameAr: l.productAr },
      declaredPacks: l.line.declaredPacks, systemPacks: l.line.systemPacks, variancePacks: l.line.declaredPacks - l.line.systemPacks,
    })),
    version: r.d.version,
  }));
}

/**
 * Workflow G step 5 (STK-010, 011; ADR-0033): the seller counts what is left
 * on the vehicle, per SKU, once a day. Compared with the system position at
 * that moment: equal is MATCHED; any difference is flagged for a manager.
 * Nothing is adjusted.
 */
export async function declareClosingStock(ctx: Ctx, input: { lines: readonly { skuId: string; packs: number }[] }): Promise<ClosingDeclaration> {
  authorize(ctx, 'inventory.declare_closing_stock');
  for (const l of input.lines) if (!Number.isSafeInteger(l.packs) || l.packs < 0) throw new DomainError('INVALID_PACK_COUNT', { value: l.packs });
  if (new Set(input.lines.map((l) => l.skuId)).size !== input.lines.length) throw new DomainError('DUPLICATE_SKU');
  return inTx(ctx, async (tx) => {
    const account = await sellerVehicleAccount(tx, ctx);
    const live = await liveSession(tx, ctx.user.id);
    if (!live) throw new DomainError('CHECK_IN_REQUIRED');
    const onVehicle = await vehicleBatches(tx, [account.vehicleId]);
    const system = [...onVehicle.reduce((m, b) => m.set(b.skuId, (m.get(b.skuId) ?? 0) + b.packs), new Map<string, number>())]
      .map(([skuId, packs]) => ({ skuId, packs }));
    const known = await tx.select({ id: skus.id }).from(skus).where(inArray(skus.id, input.lines.map((l) => l.skuId)));
    for (const l of input.lines) if (!known.some((k) => k.id === l.skuId)) throw new DomainError('NOT_FOUND', { entity: 'sku', id: l.skuId });
    const result = compareClosing(input.lines, system);

    const [row] = await mapUniqueViolations(tx.insert(closingStockDeclarations).values({
      sellerId: ctx.user.id, vehicleId: account.vehicleId, attendanceDayId: live.dayId, workDate: live.workDate, status: result.status,
      declaredAt: ctx.now, branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: closingStockDeclarations.id }), { closing_stock_one_per_day: new DomainError('ALREADY_DECLARED') });
    if (!row) throw new Error('declaration insert returned nothing');
    if (result.lines.length > 0) {
      await tx.insert(closingStockLines).values(result.lines.map((l) => ({ declarationId: row.id, skuId: l.skuId, declaredPacks: l.declaredPacks, systemPacks: l.systemPacks })));
    }
    if (result.status === 'VARIANCE_FLAGGED') {
      await notify(tx, ctx, { permission: 'inventory.audit_vehicle' }, 'CLOSING_VARIANCE', { workDate: live.workDate }, '/console/closing-stock');
    }
    await audit(tx, ctx, { action: 'inventory.closing_stock_declared', entityType: 'closing_stock_declaration', entityId: row.id, after: result });
    const [out] = await loadDeclarations(tx, eq(closingStockDeclarations.id, row.id));
    if (!out) throw new Error('declaration vanished');
    return out;
  });
}

/** STK-011: a manager reviews a flagged variance with a comment. A real loss is raised as a write-off. */
export async function reviewClosingStock(ctx: Ctx, id: string, input: { version: number; comment: string }): Promise<ClosingDeclaration> {
  authorize(ctx, 'inventory.audit_vehicle');
  const comment = input.comment.trim();
  if (!comment) throw new DomainError('REASON_REQUIRED', { action: 'review' });
  return inTx(ctx, async (tx) => {
    const [current] = await tx.select().from(closingStockDeclarations).where(eq(closingStockDeclarations.id, id)).for('update');
    if (!current) throw new DomainError('NOT_FOUND', { entity: 'closing_stock_declaration', id });
    if (current.version !== input.version) throw new DomainError('VERSION_CONFLICT', { entity: 'closing_stock_declaration', id });
    if (current.status !== 'VARIANCE_FLAGGED') throw new DomainError('ALREADY_DECIDED', { status: current.status });
    await tx.update(closingStockDeclarations).set({
      status: 'REVIEWED', reviewedAt: ctx.now, reviewedBy: ctx.user.id, reviewComment: comment, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1,
    }).where(eq(closingStockDeclarations.id, id));
    await audit(tx, ctx, { action: 'inventory.closing_stock_reviewed', entityType: 'closing_stock_declaration', entityId: id, after: { comment } });
    const [out] = await loadDeclarations(tx, eq(closingStockDeclarations.id, id));
    if (!out) throw new Error('declaration vanished');
    return out;
  });
}

/** Reviewers see every declaration; a seller sees their own. */
export async function listClosingStock(
  ctx: Ctx, filter: { status?: ClosingStatus | undefined; from?: string | undefined; to?: string | undefined } = {},
): Promise<ClosingDeclaration[]> {
  authorizeAny(ctx, ['inventory.audit_vehicle', 'inventory.declare_closing_stock']);
  const where: SQL[] = [];
  if (filter.status) where.push(eq(closingStockDeclarations.status, filter.status));
  if (filter.from) where.push(gte(closingStockDeclarations.workDate, filter.from));
  if (filter.to) where.push(lte(closingStockDeclarations.workDate, filter.to));
  if (!ctx.permissions.has('inventory.audit_vehicle')) where.push(eq(closingStockDeclarations.sellerId, ctx.user.id));
  return loadDeclarations(getDb(), and(...where));
}
