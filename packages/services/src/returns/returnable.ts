import {
  businessDate, DomainError, returnConditions, type ConditionState, type ErrorCode, type Money, type ReturnRules, type SkuUnits,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { asc, eq } from 'drizzle-orm';
import { sellerVehicleAccount } from '../attendance';
import { cashInHand } from '../cash';
import { authorize, type Ctx } from '../context';
import type { Executor } from '../platform';
import { getDb } from '../runtime';
import { loadSale, type Sale, type SaleLine } from '../sales';
import { debtsAround } from '../stores';
import { readSettings } from '../system';
import { unitsOf } from '../vehicles';
import { batchInfo, heldFromSaleOf, queryReturns, type ReturnSummary } from './access';

const { dispatchOrders, sales, warehouses } = schema;

type Named = { readonly nameEn: string; readonly nameAr: string };

export type ReturnableLine = Pick<SaleLine, 'code' | 'product' | 'variety' | 'size' | 'countUnit' | 'packs' | 'unitPrice' | 'discount' | 'total'> & {
  readonly saleLineId: string; readonly skuId: string;
  /** Packs already credited on this line — the next credit note is priced after them (ADR-0039). */ readonly credited: number;
  /** RET-001: what the store still holds from this line, batch by batch. */
  readonly batches: readonly { readonly batchId: string; readonly lotNumber: string | null; readonly expiresOn: string | null; readonly expired: boolean; readonly packs: number }[];
};

/** Where returned goods would go, and what the person returning them can do (ADR-0039). */
export type ReturnPlace =
  | { readonly kind: 'VEHICLE'; readonly notWorking: ErrorCode | null; readonly cashInHand: Money }
  | { readonly kind: 'WAREHOUSE'; readonly warehouses: readonly { readonly id: string; readonly name: Named }[] };

export type Returnable = {
  readonly sale: Sale;
  /** RET-002, OQ-020: still owed on this sale, and by the store besides. */ readonly unpaid: Money; readonly otherDebts: Money;
  /** RET-002..006: each condition now — its window and why it cannot be used, if it cannot. */ readonly conditions: readonly ConditionState[];
  readonly lines: readonly ReturnableLine[];
  readonly place: ReturnPlace;
  readonly returns: readonly ReturnSummary[];
};

export async function returnRules(db: Executor): Promise<ReturnRules> {
  const s = await readSettings(db);
  return {
    unclearedAllowed: s['returns.uncleared_payment_allowed'], unclearedWindowDays: s['returns.uncleared_payment_window_days'],
    defectiveAllowed: s['returns.defective_allowed'], defectiveWindowDays: s['returns.defective_window_days'],
  };
}

/** The completed sale a return is raised against — the seller's own on the phone (RET-001). */
export async function returnableSale(db: Executor, ctx: Ctx, saleId: string): Promise<{ sale: Sale; ledgerEntryId: string; completedAt: Date; disputable: boolean }> {
  const sale = await loadSale(db, ctx, saleId);
  if (ctx.user.role === 'SELLER' && sale.seller.id !== ctx.user.id) throw new DomainError('NOT_FOUND', { entity: 'sale', id: saleId });
  const [row] = await db.select({ ledgerEntryId: sales.ledgerEntryId, completedAt: sales.completedAt, mode: dispatchOrders.confirmationMode })
    .from(sales).leftJoin(dispatchOrders, eq(dispatchOrders.saleId, sales.id)).where(eq(sales.id, saleId));
  if (sale.status !== 'COMPLETED' || !row?.ledgerEntryId || !row.completedAt) throw new DomainError('SALE_NOT_COMPLETED', { status: sale.status });
  // OQ-012: only a dispatch the store confirmed on its owner's word can be disputed afterwards, and never by its own seller.
  const disputable = row.mode === 'OWNER_WORD' && sale.seller.id !== ctx.user.id;
  return { sale, ledgerEntryId: row.ledgerEntryId, completedAt: row.completedAt, disputable };
}

export const saleLineUnits = (sale: Sale): Map<string, SkuUnits> => new Map(sale.lines.map((l) => [l.id, unitsOf(l.size)]));

/**
 * `GET /sales/:id/returnable` (RET-001..006): everything a return needs to
 * be checked before it is sent — what the store holds from the sale, what
 * is unpaid, each condition and its window, and where the goods would go.
 */
export async function getReturnable(ctx: Ctx, saleId: string): Promise<Returnable> {
  authorize(ctx, 'returns.process');
  const db = ctx.tx ?? getDb();
  const { sale, ledgerEntryId, completedAt, disputable } = await returnableSale(db, ctx, saleId);
  const [{ held, credited }, debts, rules] = [await heldFromSaleOf(db, saleId, saleLineUnits(sale)), await debtsAround(db, sale.store.id, ledgerEntryId), await returnRules(db)];
  const info = await batchInfo(db, held.map((h) => h.batchId));
  const today = businessDate(ctx.now);
  const place: ReturnPlace = ctx.user.role === 'SELLER'
    ? { kind: 'VEHICLE', notWorking: await sellerVehicleAccount(db, ctx).then(() => null, (e: unknown) => { if (e instanceof DomainError) return e.code; throw e; }), cashInHand: await cashInHand(db, ctx.user.id) }
    : { kind: 'WAREHOUSE', warehouses: (await db.select({ id: warehouses.id, nameEn: warehouses.nameEn, nameAr: warehouses.nameAr }).from(warehouses)
      .where(eq(warehouses.isActive, true)).orderBy(asc(warehouses.createdAt))).map((w) => ({ id: w.id, name: { nameEn: w.nameEn, nameAr: w.nameAr } })) };
  return {
    sale, unpaid: debts.unpaid, otherDebts: debts.otherDebts,
    conditions: returnConditions(rules, { completedAt, unpaid: debts.unpaid, disputable }, ctx.now),
    lines: sale.lines.map((l) => ({
      saleLineId: l.id, skuId: l.skuId, code: l.code, product: l.product, variety: l.variety, size: l.size, countUnit: l.countUnit,
      packs: l.packs, unitPrice: l.unitPrice, discount: l.discount, total: l.total, credited: credited.get(l.id) ?? 0,
      batches: held.filter((h) => h.saleLineId === l.id).map((h) => {
        const b = info.get(h.batchId);
        return { batchId: h.batchId, lotNumber: b?.lotNumber ?? null, expiresOn: b?.expiresOn ?? null, expired: Boolean(b?.expiresOn && b.expiresOn < today), packs: h.packs };
      }).sort((a, b) => (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999')),
    })),
    place,
    returns: (await queryReturns(db, ctx, { saleId, limit: 100 })).items,
  };
}
