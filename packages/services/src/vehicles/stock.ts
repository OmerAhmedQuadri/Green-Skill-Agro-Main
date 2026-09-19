import {
  dec, DomainError, packsHeld, quantity, toMoney, type BatchId, type CountUnit, type Money, type PackSize, type RateFlag, type SkuId, type SkuUnits,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { currentAssignment } from '../attendance';
import { sizeOf } from '../catalogue';
import { authorize, type Ctx } from '../context';
import { computeExpiryFlags, saleHoldsByBatch } from '../inventory';
import type { Executor } from '../platform';
import { getDb } from '../runtime';

const { stockMovements, batches, skus, products, varieties, productTypes, priceLists, priceListItems, writeOffs, vehicles } = schema;

type Named = { readonly nameEn: string; readonly nameAr: string };

export const unitsOf = (s: PackSize): SkuUnits => (s.measure === 'WEIGHT' ? { measure: 'WEIGHT', packWeightG: s.packWeightG } : { measure: 'COUNT', packCount: s.packCount });

/** ADR-0031: stock is valued at the base price list, per pack. */
export async function basePrices(db: Executor, skuIds: readonly string[]): Promise<Map<string, Money>> {
  if (skuIds.length === 0) return new Map();
  const rows = await db.select({ skuId: priceListItems.skuId, price: priceListItems.price }).from(priceListItems)
    .innerJoin(priceLists, eq(priceLists.id, priceListItems.priceListId))
    .where(and(eq(priceLists.isBase, true), inArray(priceListItems.skuId, [...skuIds])));
  return new Map(rows.map((r) => [r.skuId, r.price as Money]));
}

export type VehicleBatch = {
  readonly vehicleId: string; readonly batchId: BatchId; readonly skuId: SkuId; readonly code: string;
  /** CNV-002: a conversion stays within one product and variety. */ readonly productId: string; readonly varietyId: string | null;
  readonly product: Named; readonly variety: Named | null; readonly size: PackSize; readonly countUnit: CountUnit;
  readonly lotNumber: string | null; readonly expiresOn: string | null; readonly firstReceivedAt: Date;
  /** Whole packs on the vehicle. */ readonly packs: number;
  /** Packs held by a write-off (ADR-0029) or a sale (PRC-011) awaiting a decision. */ readonly heldPacks: number;
  readonly unitPrice: Money | null;
};

/** STK-006: what is on each vehicle, batch by batch, in FEFO order. */
export async function vehicleBatches(db: Executor, vehicleIds?: readonly string[]): Promise<VehicleBatch[]> {
  if (vehicleIds?.length === 0) return [];
  const held = sql<string>`sum(${stockMovements.quantity})`;
  const rows = await db.select({
    vehicleId: sql<string>`${stockMovements.vehicleId}`, batch: batches, sku: skus, productEn: products.nameEn, productAr: products.nameAr,
    varietyEn: varieties.nameEn, varietyAr: varieties.nameAr, countUnit: productTypes.countUnit, held,
  }).from(stockMovements)
    .innerJoin(batches, eq(batches.id, stockMovements.batchId)).innerJoin(skus, eq(skus.id, batches.skuId))
    .innerJoin(products, eq(products.id, skus.productId)).innerJoin(productTypes, eq(productTypes.id, products.productTypeId))
    .leftJoin(varieties, eq(varieties.id, skus.varietyId))
    .where(and(eq(stockMovements.accountKind, 'VEHICLE'), vehicleIds ? inArray(stockMovements.vehicleId, [...vehicleIds]) : undefined))
    .groupBy(stockMovements.vehicleId, batches.id, skus.id, products.id, productTypes.id, varieties.id)
    .having(sql`${held} > 0`)
    .orderBy(asc(skus.code), sql`${batches.expiresOn} asc nulls last`, asc(batches.firstReceivedAt));
  if (rows.length === 0) return [];
  const prices = await basePrices(db, [...new Set(rows.map((r) => r.sku.id))]);
  const pending = await db.select({ vehicleId: writeOffs.vehicleId, batchId: writeOffs.batchId, q: sql<string>`sum(${writeOffs.requestedQuantity})` }).from(writeOffs)
      .where(and(eq(writeOffs.status, 'SUBMITTED'), eq(writeOffs.accountKind, 'VEHICLE'), inArray(writeOffs.batchId, rows.map((r) => r.batch.id))))
      .groupBy(writeOffs.vehicleId, writeOffs.batchId);
  const selling = await saleHoldsByBatch(db, [...new Set(rows.map((r) => r.vehicleId))]);
  return rows.map((r) => {
    const size = sizeOf(r.sku);
    const units = unitsOf(size);
    const hold = [pending.find((p) => p.vehicleId === r.vehicleId && p.batchId === r.batch.id)?.q, selling.find((p) => p.vehicleId === r.vehicleId && p.batchId === r.batch.id)?.q]
      .reduce((sum, q) => sum.plus(dec(q ?? '0')), dec('0')).toFixed(3);
    return {
      vehicleId: r.vehicleId, batchId: r.batch.id as BatchId, skuId: r.sku.id as SkuId, code: r.sku.code,
      productId: r.sku.productId, varietyId: r.sku.varietyId,
      product: { nameEn: r.productEn, nameAr: r.productAr },
      variety: r.varietyEn !== null && r.varietyAr !== null ? { nameEn: r.varietyEn, nameAr: r.varietyAr } : null,
      size, countUnit: r.countUnit, lotNumber: r.batch.lotNumber, expiresOn: r.batch.expiresOn, firstReceivedAt: r.batch.firstReceivedAt,
      packs: packsHeld(quantity(r.held), units), heldPacks: packsHeld(quantity(hold), units), unitPrice: prices.get(r.sku.id) ?? null,
    };
  });
}

export const valueOf = (lines: readonly { packs: number; unitPrice: Money | null }[]): Money =>
  toMoney(lines.reduce((sum, l) => (l.unitPrice === null ? sum : sum.plus(dec(l.unitPrice).times(l.packs))), dec('0')));

export type MyVehicleBatch = VehicleBatch & {
  /** EXP-007: the indicator on affected items. */
  readonly expiry: { readonly flagged: boolean; readonly time: boolean; readonly rate: RateFlag | null; readonly prioritised: boolean; readonly daysLeft: number | null };
};

export type MyVehicle = {
  readonly vehicle: { readonly id: string; readonly registration: string; readonly description: string | null } | null;
  readonly batches: readonly MyVehicleBatch[];
  readonly value: Money; readonly packs: number; readonly flaggedCount: number;
};

/** USR-013, EXP-007: the seller's own vehicle stock, with expiry indicators. */
export async function getMyVehicle(ctx: Ctx): Promise<MyVehicle> {
  authorize(ctx, 'inventory.view_own_vehicle');
  const db = getDb();
  const assignment = await currentAssignment(db, ctx.user.id);
  if (!assignment) return { vehicle: null, batches: [], value: '0.00' as Money, packs: 0, flaggedCount: 0 };
  const [[vehicle], lines] = await Promise.all([
    db.select().from(vehicles).where(eq(vehicles.id, assignment.vehicleId)),
    vehicleBatches(db, [assignment.vehicleId]),
  ]);
  if (!vehicle) throw new DomainError('NOT_FOUND', { entity: 'vehicle', id: assignment.vehicleId });
  const flags = await computeExpiryFlags(ctx.now, lines.map((l) => l.batchId));
  const withExpiry = lines.map((l) => {
    const f = flags.find((x) => x.batchId === l.batchId);
    return {
      ...l,
      expiry: {
        flagged: f ? f.time || f.rate.flagged || f.prioritised : false, time: f?.time ?? false, rate: f?.rate ?? null,
        prioritised: f?.prioritised ?? false, daysLeft: f?.daysLeft ?? null,
      },
    };
  });
  return {
    vehicle: { id: vehicle.id, registration: vehicle.registration, description: vehicle.description },
    batches: withExpiry, value: valueOf(lines), packs: lines.reduce((n, l) => n + l.packs, 0),
    flaggedCount: withExpiry.filter((b) => b.expiry.flagged).length,
  };
}
