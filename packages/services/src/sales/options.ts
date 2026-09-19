import {
  applicableItemCeiling, dec, isDomainError, packCount, percent, toBaseUnits, type CountUnit, type CreditMode, type CreditStatus,
  type DocumentSendingMode, type ErrorCode, type Money, type PackSize, type Percent, type SaleBatch, type SaleTerms, type StoreStatus,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, inArray, or } from 'drizzle-orm';
import { sellerVehicleAccount } from '../attendance';
import { authorize, type Ctx } from '../context';
import { computeExpiryFlags } from '../inventory';
import type { Executor } from '../platform';
import { getDb } from '../runtime';
import { loadStore } from '../stores';
import { readSettings } from '../system';
import { unitsOf, vehicleBatches } from '../vehicles';

const { priceLists, priceListItems, skuDiscountCeilings } = schema;

type Named = { readonly nameEn: string; readonly nameAr: string };

export type SaleLimits = {
  /** PRC-004 */ readonly orderCeiling: Percent;
  /** PRC-016 */ readonly absoluteMaximum: Percent;
  /** PRC-015 */ readonly approvalExpiryMinutes: number;
  /** DOC-004 */ readonly sendingMode: DocumentSendingMode;
};

export async function saleLimits(db: Executor): Promise<SaleLimits> {
  const settings = await readSettings(db);
  return {
    orderCeiling: percent(settings['discount.order_ceiling']), absoluteMaximum: percent(settings['discount.absolute_maximum']),
    approvalExpiryMinutes: settings['discount.approval_expiry_minutes'], sendingMode: settings['documents.sending'],
  };
}

/**
 * SAL-004, PRC-003, PRC-005: each SKU's price on the store's list, falling
 * back to the base list (ADR-0037), and its own ceiling or the default item
 * ceiling.
 */
export async function saleTerms(db: Executor, priceListId: string, skuIds: readonly string[]): Promise<Map<string, SaleTerms>> {
  if (skuIds.length === 0) return new Map();
  const settings = await readSettings(db);
  const prices = await db.select({ skuId: priceListItems.skuId, price: priceListItems.price, isBase: priceLists.isBase, listId: priceLists.id })
    .from(priceListItems).innerJoin(priceLists, eq(priceLists.id, priceListItems.priceListId))
    .where(and(inArray(priceListItems.skuId, [...skuIds]), or(eq(priceLists.id, priceListId), eq(priceLists.isBase, true))));
  const ceilings = await db.select().from(skuDiscountCeilings).where(inArray(skuDiscountCeilings.skuId, [...skuIds]));
  return new Map(skuIds.map((skuId) => {
    const own = prices.find((p) => p.skuId === skuId && p.listId === priceListId) ?? prices.find((p) => p.skuId === skuId && p.isBase);
    const ceiling = ceilings.find((c) => c.skuId === skuId);
    return [skuId, {
      unitPrice: (own?.price ?? null) as Money | null,
      itemCeiling: percent(ceiling ? dec(ceiling.ceiling).toString() : settings['discount.item_ceiling']),
    }];
  }));
}

/**
 * SAL-003, SAL-008: the vehicle's batches with what can be sold of each —
 * its position less what write-offs and pending sales hold — flagged batches
 * first (EXP-006).
 */
export async function sellableBatches(db: Executor, vehicleId: string, now: Date): Promise<(SaleBatch & { packs: number; size: PackSize })[]> {
  const lines = await vehicleBatches(db, [vehicleId]);
  const flags = await computeExpiryFlags(now, lines.map((l) => l.batchId));
  return lines.map((l) => {
    const f = flags.find((x) => x.batchId === l.batchId);
    const packs = Math.max(0, l.packs - l.heldPacks);
    return {
      batchId: l.batchId, skuId: l.skuId, expiresOn: l.expiresOn, receivedAt: l.firstReceivedAt,
      available: toBaseUnits(packCount(packs), unitsOf(l.size)), flagged: f ? f.time || f.rate.flagged || f.prioritised : false, packs, size: l.size,
    };
  });
}

export type SaleItem = {
  readonly skuId: string; readonly code: string; readonly product: Named; readonly variety: Named | null;
  readonly size: PackSize; readonly countUnit: CountUnit;
  /** SAL-003, STK-015: whole packs that can be sold now. */ readonly sellablePacks: number;
  /** SAL-004: null — not on the store's list or the base list, so not sellable. */ readonly unitPrice: Money | null;
  /** PRC-006: the tighter of the item's and the order's ceiling. */ readonly ceiling: Percent;
};

export type SaleOptions = {
  readonly store: { readonly id: string; readonly name: string; readonly status: StoreStatus; readonly creditMode: CreditMode; readonly credit: CreditStatus };
  /** ATT-010: why the seller cannot sell now, if they cannot — shown before anything else. */
  readonly notWorking: ErrorCode | null;
  readonly vehicle: { readonly id: string } | null;
  readonly items: readonly SaleItem[];
  readonly limits: SaleLimits;
  /** PRC-008: may discount at all. */ readonly canDiscount: boolean;
};

/**
 * SAL-001..005, CRD-005: what the sale screen needs, credit first — so a
 * blocked store shows its block and reason before any item is added.
 */
export async function saleOptions(ctx: Ctx, storeId: string): Promise<SaleOptions> {
  authorize(ctx, 'sales.record');
  const db = ctx.tx ?? getDb();
  const store = await loadStore(db, ctx, storeId);
  const limits = await saleLimits(db);
  let vehicleId: string | null = null;
  let notWorking: ErrorCode | null = null;
  try {
    vehicleId = (await sellerVehicleAccount(db, ctx)).vehicleId;
  } catch (error) {
    if (!isDomainError(error)) throw error;
    notWorking = error.code;
  }
  const base = {
    store: { id: store.id, name: store.name, status: store.status, creditMode: store.creditMode, credit: store.credit },
    notWorking, vehicle: vehicleId ? { id: vehicleId } : null, limits, canDiscount: ctx.permissions.has('sales.apply_discount'),
  };
  if (!vehicleId) return { ...base, items: [] };

  const lines = await vehicleBatches(db, [vehicleId]);
  const skuIds = [...new Set(lines.map((l) => l.skuId))];
  const terms = await saleTerms(db, store.priceList.id, skuIds);
  const items = skuIds.map((skuId): SaleItem => {
    const own = lines.filter((l) => l.skuId === skuId);
    const first = own[0];
    if (!first) throw new Error('sku without batches');
    const term = terms.get(skuId);
    return {
      skuId, code: first.code, product: first.product, variety: first.variety, size: first.size, countUnit: first.countUnit,
      sellablePacks: own.reduce((n, l) => n + Math.max(0, l.packs - l.heldPacks), 0),
      unitPrice: term?.unitPrice ?? null, ceiling: applicableItemCeiling(limits.orderCeiling, term?.itemCeiling ?? limits.orderCeiling),
    };
  }).filter((i) => i.sellablePacks > 0);
  return { ...base, items };
}
