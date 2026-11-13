import {
  businessDate, correctedImportedSale, correctedSale, correctionReason, Dec, dec, DomainError, packCount, quantity, toBaseUnits, toMoney, toPacks,
  transfer, transitionSale, type ImportedSaleChange, type ImportedSaleValues, type Leg, type Money, type Percent, type Quantity, type SaleChange,
  type SaleValues, type StockAccount,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { cashInHand, postCashCorrection } from '../cash';
import { sizeOf } from '../catalogue';
import { authorize, authorizeAny, type Ctx } from '../context';
import { batchRefs, positionOf, postStockMovements, warehouseAccount } from '../inventory';
import { audit, inTx, pageLimit, type Executor, type Tx } from '../platform';
import { dayAfter, rebuildRollup } from '../reports';
import { getDb } from '../runtime';
import { latestDocument, reissueDeliveryDocument } from '../sales';
import { unitsOf } from '../vehicles';
import { requireCorrectionSession } from './sessions';
import { correctImportedBill, correctSaleBill, type StoreCorrectionEffect } from './store-account';

const {
  sales, saleLines, saleLineAllocations, saleCorrections, saleCorrectionAllocations, skus, batches, payments, returns, returnLines, vehicles,
  warehouses, stores, users, correctionSessions, importedSales, importedSaleLines, importBatches, storeLedgerEntries, storeCorrections, deliveryDocuments,
} = schema;

/**
 * Sale corrections (COR-006; ADR-0059, amended 28 October), in the Super Admin's open session with a reason of their
 * own. A sale made in the app keeps its corrected figures, and the correction keeps what it was; the Super Admin
 * chooses what follows, and each follows by being reversed and posted again, never overwritten:
 *   - stock, back to or out of the batch and place each line was sold from;
 *   - the delivery document, reissued as its next version under the same number;
 *   - the bill in the store's account (a store correction naming the sale);
 *   - for an open sale paid in cash, its seller's cash in hand.
 * Moving a sale to another store moves its bill: the account always follows a move.
 *
 * An imported sale's correction writes the corrected invoice and marks the old one replaced. Only its bill follows,
 * when it is in the account already; before re-verification, the store is shown and posted the corrected one.
 */

export type SaleCorrectionInput = SaleChange & {
  readonly reason?: string | null | undefined;
  readonly stock?: boolean | undefined; readonly document?: boolean | undefined;
  readonly account?: boolean | undefined; readonly cashInHand?: boolean | undefined;
};

/** COR-002: what a sale correction moves — and what it could move, chosen or not. */
export type SaleCorrectionEffect = {
  readonly available: { readonly stock: boolean; readonly document: boolean; readonly account: boolean; readonly cashInHand: boolean };
  readonly total: { readonly before: Money; readonly after: Money | null };
  /** Each batch's stock moved, in packs: positive back to the place, negative taken out of it. */
  readonly stock: readonly { readonly code: string; readonly lotNumber: string | null; readonly place: string; readonly packs: number }[];
  readonly document: { readonly number: string; readonly version: number } | null;
  readonly stores: StoreCorrectionEffect['stores'];
  readonly cashInHand: StoreCorrectionEffect['cashInHand'];
};

export type ImportedSaleCorrectionInput = ImportedSaleChange & { readonly reason?: string | null | undefined };

export type ImportedSaleCorrectionEffect = {
  readonly total: { readonly before: Money; readonly after: Money };
  /** In the store's account already: its bill follows. Not yet: re-verification posts the corrected one. */
  readonly posted: boolean;
  readonly stores: StoreCorrectionEffect['stores'];
};

export type SaleCorrectionView = {
  readonly id: string; readonly number: number; readonly session: { readonly id: string; readonly number: number };
  readonly sale: { readonly id: string; readonly documentNumber: string | null } | null;
  readonly imported: { readonly id: string; readonly serial: number; readonly book: string; readonly row: number } | null;
  readonly store: { readonly id: string; readonly name: string } | null;
  readonly total: { readonly before: Money; readonly after: Money | null };
  readonly applied: { readonly stock: boolean; readonly document: boolean; readonly account: boolean; readonly cashInHand: boolean };
  readonly reason: string; readonly by: string; readonly at: Date;
};

/** An imported invoice as the Super Admin corrects it: the one that stands, with its lines. */
export type ImportedSaleDetail = ImportedSaleValues & {
  readonly id: string; readonly soldOn: string; readonly serial: number; readonly book: string; readonly row: number; readonly posted: boolean;
  readonly lines: readonly (ImportedSaleValues['lines'][number] & { readonly code: string | null })[];
};

class Rehearsed<T> extends Error {
  constructor(readonly effect: T) { super('rehearsed'); }
}

/** COR-002: the effect a change would have, found by making it and rolling it back. */
async function rehearse<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await getDb().transaction(async (tx) => { throw new Rehearsed(await work(tx)); });
  } catch (error) {
    if (error instanceof Rehearsed) return error.effect as T;
    throw error;
  }
  throw new Error('a rehearsed correction did not roll back');
}

/** COR-006: correct a sale made in the app, with its own reason, in the caller's open session. */
export async function correctSale(ctx: Ctx, saleId: string, input: SaleCorrectionInput): Promise<{ number: number; effect: SaleCorrectionEffect }> {
  authorize(ctx, 'system.correct_history');
  return inTx(ctx, (tx) => applySale(tx, ctx, saleId, input, correctionReason(input.reason)));
}

/** COR-002: what correcting the sale so would move, before it is confirmed. */
export async function previewSaleCorrection(ctx: Ctx, saleId: string, input: SaleCorrectionInput): Promise<SaleCorrectionEffect> {
  authorize(ctx, 'system.correct_history');
  return (await rehearse((tx) => applySale(tx, ctx, saleId, input, input.reason?.trim() || '(preview)'))).effect;
}

/** COR-006: correct an imported sale's lines and total, with its own reason, in the caller's open session. */
export async function correctImportedSale(
  ctx: Ctx, importedSaleId: string, input: ImportedSaleCorrectionInput,
): Promise<{ number: number; effect: ImportedSaleCorrectionEffect }> {
  authorize(ctx, 'system.correct_history');
  return inTx(ctx, (tx) => applyImported(tx, ctx, importedSaleId, input, correctionReason(input.reason)));
}

export async function previewImportedSaleCorrection(ctx: Ctx, importedSaleId: string, input: ImportedSaleCorrectionInput): Promise<ImportedSaleCorrectionEffect> {
  authorize(ctx, 'system.correct_history');
  return (await rehearse((tx) => applyImported(tx, ctx, importedSaleId, input, input.reason?.trim() || '(preview)'))).effect;
}

type LineRow = { l: typeof saleLines.$inferSelect; sku: typeof skus.$inferSelect };

async function applySale(tx: Tx, ctx: Ctx, saleId: string, input: SaleCorrectionInput, reason: string) {
  const session = await requireCorrectionSession(tx, ctx);
  const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).for('update');
  if (!sale) throw new DomainError('NOT_FOUND', { entity: 'sale', id: saleId });
  if (sale.status !== 'COMPLETED' || !sale.completedAt) throw new DomainError('NOT_CORRECTABLE', { reason: sale.status });
  const lineRows: LineRow[] = await tx.select({ l: saleLines, sku: skus }).from(saleLines).innerJoin(skus, eq(skus.id, saleLines.skuId))
    .where(eq(saleLines.saleId, saleId)).orderBy(asc(skus.code));
  const original: SaleValues = {
    storeId: sale.storeId, gross: sale.gross as Money, discount: sale.discount as Money, total: sale.total as Money,
    lines: lineRows.map((r) => ({
      lineId: r.l.id, skuId: r.l.skuId, packs: r.l.packs, unitPrice: r.l.unitPrice as Money, discount: r.l.discount as Percent,
      gross: r.l.gross as Money, discountAmount: r.l.discountAmount as Money, total: r.l.total as Money,
    })),
  };
  const after = correctedSale(original, input);

  // What the store has returned stays returned: no line goes below it, and a sale with returns is not removed.
  const credited = await creditedPacks(tx, saleId);
  if (!after && credited.size > 0) throw new DomainError('SALE_HAS_RETURNS');
  for (const line of after?.lines ?? []) {
    const back = credited.get(line.lineId) ?? 0;
    if (line.packs < back) throw new DomainError('BELOW_RETURNED', { lineId: line.lineId, returned: back });
  }

  const moved = original.lines.map((l, i) => ({ line: l, row: lineRows[i] as LineRow, packs: (after?.lines[i]?.packs ?? 0) - l.packs })).filter((m) => m.packs !== 0);
  const storeMoved = after !== null && after.storeId !== original.storeId;
  const totalChanged = !after || !dec(after.total).eq(dec(original.total));
  const [payment] = sale.paymentId ? await tx.select().from(payments).where(eq(payments.id, sale.paymentId)) : [];
  const available = {
    stock: moved.length > 0,
    document: after !== null,
    account: sale.storeId !== null && (totalChanged || storeMoved),
    cashInHand: sale.storeId === null && payment?.method === 'CASH' && totalChanged,
  };
  // A sale moved to another store takes its bill with it.
  const chosen = {
    stock: Boolean(input.stock) && available.stock, document: Boolean(input.document) && available.document,
    account: (Boolean(input.account) || storeMoved) && available.account, cashInHand: Boolean(input.cashInHand) && available.cashInHand,
  };
  if (chosen.document) {
    const doc = await latestDocument(tx, saleId);
    if (!doc || doc.status === 'PENDING') throw new DomainError('DOCUMENT_NOT_READY', { status: doc?.status ?? 'MISSING' });
  }
  const id = newId();

  // The sale's own figures: corrected in place, what they were kept in the correction.
  if (after) {
    for (const [i, line] of after.lines.entries()) {
      const was = original.lines[i];
      const row = lineRows[i];
      if (!was || !row || (was.packs === line.packs && dec(was.unitPrice).eq(dec(line.unitPrice)))) continue;
      await tx.update(saleLines).set({
        packs: line.packs, quantity: toBaseUnits(packCount(line.packs), unitsOf(sizeOf(row.sku))), unitPrice: line.unitPrice,
        gross: line.gross, discountAmount: line.discountAmount, total: line.total,
      }).where(eq(saleLines.id, line.lineId));
    }
  }

  let account: { storeCorrectionId: string; effect: StoreCorrectionEffect; postedEntryId: string | null } | null = null;
  if (chosen.account && sale.ledgerEntryId) {
    const made = await correctSaleBill(tx, ctx, saleId, sale.ledgerEntryId, after ? { amount: after.total, storeId: after.storeId } : { remove: true }, reason);
    account = { storeCorrectionId: made.id, effect: made.effect, postedEntryId: made.postedEntryId };
  }
  await tx.update(sales).set({
    ...(after ? { gross: after.gross, discount: after.discount, total: after.total, storeId: after.storeId } : { status: transitionSale(sale.status, 'remove') }),
    ...(account?.postedEntryId ? { ledgerEntryId: account.postedEntryId } : {}),
    updatedAt: ctx.now, updatedBy: ctx.user.id, version: sale.version + 1,
  }).where(eq(sales.id, saleId));

  const document = chosen.document ? await reissueDeliveryDocument(tx, ctx, saleId) : null;
  await tx.insert(saleCorrections).values({
    id, sessionId: session.id, saleId, before: original, after, reason, ...chosen,
    storeCorrectionId: account?.storeCorrectionId ?? null, documentId: document?.id ?? null, branchId: ctx.branchId, createdBy: ctx.user.id,
  });
  const [{ number } = { number: 0 }] = await tx.select({ number: saleCorrections.number }).from(saleCorrections).where(eq(saleCorrections.id, id));

  const stock = chosen.stock ? await moveStock(tx, ctx, sale, id, moved) : [];

  let cash: StoreCorrectionEffect['cashInHand'] = null;
  if (chosen.cashInHand && payment) {
    const before = await cashInHand(tx, payment.receivedBy);
    await postCashCorrection(tx, ctx, {
      sellerId: payment.receivedBy, amount: toMoney(dec(after?.total ?? '0').minus(dec(original.total))), referenceType: 'SALE_CORRECTION', referenceId: id,
    });
    const [collector] = await tx.select({ name: users.name }).from(users).where(eq(users.id, payment.receivedBy));
    cash = { seller: { id: payment.receivedBy, name: collector?.name ?? '' }, before, after: await cashInHand(tx, payment.receivedBy) };
  }

  // Sales analytics read the day's rollup: rebuilt now, with the sale as corrected.
  const day = businessDate(sale.completedAt);
  await rebuildRollup({ ...ctx, tx }, day, dayAfter(day));

  await audit(tx, ctx, {
    action: 'corrections.sale_corrected', entityType: 'sale', entityId: saleId,
    before: original, after: { values: after, reason, session: session.number, number, applied: chosen, document: document?.version ?? null },
  });
  const effect: SaleCorrectionEffect = {
    available, total: { before: original.total, after: after?.total ?? null }, stock,
    document: document ? { number: document.number, version: document.version } : null,
    stores: account?.effect.stores ?? [], cashInHand: cash,
  };
  return { number, effect };
}

/** RET-002: the packs of each line the store has had credited back — a correction leaves at least these sold. */
async function creditedPacks(tx: Executor, saleId: string): Promise<Map<string, number>> {
  const rows = await tx.select({ lineId: returnLines.saleLineId, packs: sql<number>`sum(${returnLines.packs})::int` }).from(returnLines)
    .innerJoin(returns, eq(returns.id, returnLines.returnId))
    .where(and(eq(returns.saleId, saleId), eq(returns.kind, 'CREDIT_NOTE'))).groupBy(returnLines.saleLineId);
  return new Map(rows.map((r) => [r.lineId, r.packs]));
}

/**
 * COR-006: stock follows the corrected packs, through the batches each line was sold from and at the place it was
 * sold from — its vehicle, or the warehouse a dispatched sale left. Packs given back return to the latest-expiring
 * batches first; packs taken come from the soonest, as far as the place still holds them.
 */
async function moveStock(
  tx: Tx, ctx: Ctx, sale: typeof sales.$inferSelect, correctionId: string, moved: readonly { line: SaleValues['lines'][number]; row: LineRow; packs: number }[],
): Promise<SaleCorrectionEffect['stock']> {
  const place: StockAccount = sale.vehicleId ? { kind: 'VEHICLE', vehicleId: sale.vehicleId } : await warehouseAccount(tx);
  const placeName = await placeNameOf(tx, place);
  const lineIds = moved.map((m) => m.line.lineId);
  const [allocated, corrected, returned] = [
    await tx.select({ lineId: saleLineAllocations.saleLineId, batchId: saleLineAllocations.batchId, quantity: saleLineAllocations.quantity })
      .from(saleLineAllocations).where(inArray(saleLineAllocations.saleLineId, lineIds)),
    await tx.select({ lineId: saleCorrectionAllocations.saleLineId, batchId: saleCorrectionAllocations.batchId, quantity: saleCorrectionAllocations.quantity })
      .from(saleCorrectionAllocations).where(inArray(saleCorrectionAllocations.saleLineId, lineIds)),
    await tx.select({ lineId: returnLines.saleLineId, batchId: returnLines.batchId, quantity: sql<string>`-${returnLines.quantity}` })
      .from(returnLines).where(inArray(returnLines.saleLineId, lineIds)),
  ];
  // What each line still has sold from each batch.
  const sold = new Map<string, Dec>();
  for (const r of [...allocated, ...corrected, ...returned]) {
    const key = `${r.lineId}|${r.batchId}`;
    sold.set(key, (sold.get(key) ?? dec('0')).plus(dec(r.quantity)));
  }
  const batchIds = [...new Set([...allocated, ...corrected].map((r) => r.batchId))];
  const info = batchIds.length === 0 ? [] : await tx.select({ id: batches.id, lotNumber: batches.lotNumber, expiresOn: batches.expiresOn }).from(batches)
    .where(inArray(batches.id, batchIds)).orderBy(sql`${batches.expiresOn} asc nulls last`, asc(batches.id));
  const refs = await batchRefs(tx, batchIds);
  const legs: Leg[] = [];
  const rows: { lineId: string; batchId: string; quantity: string }[] = [];
  const effect: { code: string; lotNumber: string | null; place: string; packs: number }[] = [];
  for (const m of moved) {
    const units = unitsOf(sizeOf(m.row.sku));
    let left = dec(toBaseUnits(packCount(Math.abs(m.packs)), units));
    const own = info.filter((b) => sold.has(`${m.line.lineId}|${b.id}`));
    for (const b of m.packs < 0 ? [...own].reverse() : own) {
      if (left.isZero()) break;
      const ref = refs.get(b.id);
      if (!ref) throw new Error('batch missing');
      const can = m.packs < 0
        ? (sold.get(`${m.line.lineId}|${b.id}`) ?? dec('0'))
        : Dec.max(dec(await positionOf(tx, b.id, place)), dec('0'));
      const q = Dec.min(left, can);
      if (!q.gt(0)) continue;
      const amount = q.toFixed(3) as Quantity;
      legs.push(...(m.packs < 0 ? transfer(ref, amount, { kind: 'SOLD' }, place) : transfer(ref, amount, place, { kind: 'SOLD' })));
      rows.push({ lineId: m.line.lineId, batchId: b.id, quantity: m.packs < 0 ? `-${amount}` : amount });
      effect.push({ code: m.row.sku.code, lotNumber: b.lotNumber, place: placeName, packs: (m.packs < 0 ? 1 : -1) * toPacks(quantity(amount), units).toNumber() });
      left = left.minus(q);
    }
    if (left.gt(0)) {
      throw new DomainError('INSUFFICIENT_STOCK', { skuId: m.line.skuId, account: place.kind, requested: toPacks(quantity(left.toFixed(3)), units).toString() });
    }
  }
  if (legs.length > 0) {
    await postStockMovements(tx, ctx, { referenceType: 'SALE_CORRECTION', referenceId: correctionId, legs });
    await tx.insert(saleCorrectionAllocations).values(rows.map((r) => ({ correctionId, saleLineId: r.lineId, batchId: r.batchId, quantity: r.quantity })));
  }
  return effect;
}

async function placeNameOf(tx: Executor, place: StockAccount): Promise<string> {
  if (place.kind === 'VEHICLE') {
    const [v] = await tx.select({ registration: vehicles.registration }).from(vehicles).where(eq(vehicles.id, place.vehicleId));
    return v?.registration ?? '';
  }
  if (place.kind === 'WAREHOUSE') {
    const [w] = await tx.select({ name: warehouses.nameEn }).from(warehouses).where(eq(warehouses.id, place.warehouseId));
    return w?.name ?? '';
  }
  return place.kind;
}

async function applyImported(tx: Tx, ctx: Ctx, importedSaleId: string, input: ImportedSaleCorrectionInput, reason: string) {
  const session = await requireCorrectionSession(tx, ctx);
  const [row] = await tx.select({ s: importedSales, batchStatus: importBatches.status }).from(importedSales)
    .innerJoin(importBatches, eq(importBatches.id, importedSales.batchId)).where(eq(importedSales.id, importedSaleId)).for('update', { of: importedSales });
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'imported_sale', id: importedSaleId });
  if (row.s.replacedBy) throw new DomainError('ALREADY_CORRECTED');
  if (row.batchStatus === 'UNDONE') throw new DomainError('NOT_CORRECTABLE', { reason: 'UNDONE' });
  const lines = await tx.select().from(importedSaleLines).where(eq(importedSaleLines.importedSaleId, importedSaleId)).orderBy(asc(importedSaleLines.lineNo));
  const original: ImportedSaleValues = {
    subtotal: row.s.subtotal as Money, discount: row.s.discount as Money, total: row.s.total as Money,
    lines: lines.map((l) => ({ item: l.itemWritten, skuId: l.skuId, packs: dec(l.packs).toFixed(3), unitPrice: l.unitPrice as Money, amount: l.amount as Money })),
  };
  const after = correctedImportedSale(original, input);
  const id = newId();

  // Its bill, where it is in the account already, follows — as a bill corrected from the account would.
  const bill = await standingImportedBill(tx, row.s);
  const account = bill && !dec(bill.amount).eq(dec(after.total))
    ? await correctImportedBill(tx, ctx, bill.id, { amount: after.total }, reason)
    : null;
  await tx.insert(saleCorrections).values({
    id, sessionId: session.id, importedSaleId, before: original, after, reason, account: account !== null,
    storeCorrectionId: account?.id ?? null, branchId: ctx.branchId, createdBy: ctx.user.id,
  });
  await tx.update(importedSales).set({ replacedBy: id }).where(eq(importedSales.id, importedSaleId));
  const correctedId = newId();
  await tx.insert(importedSales).values({
    id: correctedId, batchId: row.s.batchId, storeId: row.s.storeId, sellerId: row.s.sellerId, soldOn: row.s.soldOn, book: row.s.book,
    bookRow: row.s.bookRow, serial: row.s.serial, storeNameWritten: row.s.storeNameWritten,
    subtotal: after.subtotal, discount: after.discount, total: after.total, correctionId: id, branchId: row.s.branchId, createdBy: ctx.user.id,
  });
  await tx.insert(importedSaleLines).values(after.lines.map((l, i) => ({
    importedSaleId: correctedId, lineNo: i + 1, itemWritten: l.item, packWritten: lines[i]?.itemWritten === l.item ? (lines[i]?.packWritten ?? null) : null,
    skuId: l.skuId, packs: l.packs, unitPrice: l.unitPrice, amount: l.amount,
  })));
  const [{ number } = { number: 0 }] = await tx.select({ number: saleCorrections.number }).from(saleCorrections).where(eq(saleCorrections.id, id));
  await audit(tx, ctx, {
    action: 'corrections.imported_sale_corrected', entityType: 'imported_sale', entityId: importedSaleId,
    before: original, after: { values: after, reason, session: session.number, number, corrected: correctedId },
  });
  const effect: ImportedSaleCorrectionEffect = {
    total: { before: original.total, after: after.total }, posted: bill !== null, stores: account?.effect.stores ?? [],
  };
  return { number, effect };
}

/**
 * The bill an imported invoice stands as in its store's account: the one its first posting made, followed through
 * any corrections of it — or null, before re-verification or once a correction removed it.
 */
async function standingImportedBill(tx: Executor, sale: typeof importedSales.$inferSelect): Promise<typeof storeLedgerEntries.$inferSelect | null> {
  // Every version of the invoice: the account was posted from whichever stood at re-verification.
  const versions = [sale.id];
  for (let at = sale; at.correctionId;) {
    const [made] = await tx.select({ previous: saleCorrections.importedSaleId }).from(saleCorrections).where(eq(saleCorrections.id, at.correctionId));
    const [previous] = made?.previous ? await tx.select().from(importedSales).where(eq(importedSales.id, made.previous)) : [];
    if (!previous) break;
    versions.push(previous.id);
    at = previous;
  }
  let [entry] = await tx.select().from(storeLedgerEntries)
    .where(and(eq(storeLedgerEntries.referenceType, 'IMPORTED_SALE'), inArray(storeLedgerEntries.referenceId, versions)));
  while (entry) {
    const [corrected] = await tx.select({ id: storeCorrections.id, after: storeCorrections.after }).from(storeCorrections)
      .where(eq(storeCorrections.originalEntryId, entry.id));
    if (!corrected) return entry;
    if (!corrected.after) return null;
    [entry] = await tx.select().from(storeLedgerEntries)
      .where(and(eq(storeLedgerEntries.referenceType, 'CORRECTION'), eq(storeLedgerEntries.referenceId, corrected.id), sql`${storeLedgerEntries.amount} > 0`));
  }
  return null;
}

/** COR-006: a store's imported invoices that stand, with their lines, for the Super Admin to correct. */
export async function listImportedSales(ctx: Ctx, storeId: string): Promise<ImportedSaleDetail[]> {
  authorize(ctx, 'system.correct_history');
  const db = getDb();
  const rows = await db.select().from(importedSales).innerJoin(importBatches, eq(importBatches.id, importedSales.batchId))
    .where(and(eq(importedSales.storeId, storeId), isNull(importedSales.replacedBy), sql`${importBatches.status} <> 'UNDONE'`))
    .orderBy(asc(importedSales.soldOn), asc(importedSales.serial));
  const ids = rows.map((r) => r.imported_sales.id);
  const lines = ids.length === 0 ? [] : await db.select({ l: importedSaleLines, code: skus.code }).from(importedSaleLines)
    .leftJoin(skus, eq(skus.id, importedSaleLines.skuId)).where(inArray(importedSaleLines.importedSaleId, ids)).orderBy(asc(importedSaleLines.lineNo));
  const posted = new Set<string>();
  for (const r of rows) if (await standingImportedBill(db, r.imported_sales)) posted.add(r.imported_sales.id);
  return rows.map(({ imported_sales: s }) => ({
    id: s.id, soldOn: s.soldOn, serial: s.serial, book: s.book, row: s.bookRow, posted: posted.has(s.id),
    subtotal: s.subtotal as Money, discount: s.discount as Money, total: s.total as Money,
    lines: lines.filter((l) => l.l.importedSaleId === s.id).map((l) => ({
      item: l.l.itemWritten, skuId: l.l.skuId, code: l.code, packs: dec(l.l.packs).toFixed(3), unitPrice: l.l.unitPrice as Money, amount: l.l.amount as Money,
    })),
  }));
}

/** The Corrections page: every sale correction, newest first. */
export async function listSaleCorrections(
  ctx: Ctx, filter: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: SaleCorrectionView[]; nextCursor: string | null }> {
  authorizeAny(ctx, ['system.correct_history', 'system.view_audit_log']);
  const limit = pageLimit(filter.limit);
  const before = filter.cursor && /^\d{1,9}$/.test(filter.cursor) ? Number(filter.cursor) : null;
  if (filter.cursor && before === null) throw new DomainError('INVALID_CURSOR');
  const db = getDb();
  const rows = await db.select({ c: saleCorrections, sessionNumber: correctionSessions.number, by: users.name }).from(saleCorrections)
    .innerJoin(correctionSessions, eq(correctionSessions.id, saleCorrections.sessionId)).innerJoin(users, eq(users.id, saleCorrections.createdBy))
    .where(before === null ? undefined : lt(saleCorrections.number, before))
    .orderBy(desc(saleCorrections.number)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const saleIds = page.flatMap((r) => (r.c.saleId ? [r.c.saleId] : []));
  const importedIds = page.flatMap((r) => (r.c.importedSaleId ? [r.c.importedSaleId] : []));
  const [saleRows, importedRows] = [
    saleIds.length ? await db.select({ id: sales.id, number: deliveryDocuments.number }).from(sales)
      .leftJoin(deliveryDocuments, and(eq(deliveryDocuments.saleId, sales.id), eq(deliveryDocuments.version, 1))).where(inArray(sales.id, saleIds)) : [],
    importedIds.length ? await db.select().from(importedSales).where(inArray(importedSales.id, importedIds)) : [],
  ];
  type Stored = { storeId?: string | null; total: Money };
  const storeIds = [...new Set([
    ...page.flatMap((r) => [(r.c.before as Stored).storeId, (r.c.after as Stored | null)?.storeId]),
    ...importedRows.map((s) => s.storeId),
  ].filter((s): s is string => Boolean(s)))];
  const names = new Map(storeIds.length === 0 ? [] : (await db.select({ id: stores.id, name: stores.name }).from(stores).where(inArray(stores.id, storeIds))).map((s) => [s.id, s.name]));
  const last = page.at(-1);
  return {
    items: page.map((r) => {
      const sale = saleRows.find((s) => s.id === r.c.saleId);
      const imported = importedRows.find((s) => s.id === r.c.importedSaleId);
      const was = r.c.before as Stored;
      const now = r.c.after as Stored | null;
      const storeId = now?.storeId ?? was.storeId ?? imported?.storeId ?? null;
      return {
        id: r.c.id, number: r.c.number, session: { id: r.c.sessionId, number: r.sessionNumber },
        sale: sale ? { id: sale.id, documentNumber: sale.number } : null,
        imported: imported ? { id: imported.id, serial: imported.serial, book: imported.book, row: imported.bookRow } : null,
        store: storeId ? { id: storeId, name: names.get(storeId) ?? '' } : null,
        total: { before: was.total, after: now?.total ?? null },
        applied: { stock: r.c.stock, document: r.c.document, account: r.c.account, cashInHand: r.c.cashInHand },
        reason: r.c.reason, by: r.by, at: r.c.createdAt,
      };
    }),
    nextCursor: rows.length > limit && last ? String(last.c.number) : null,
  };
}
