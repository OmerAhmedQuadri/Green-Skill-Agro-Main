import type { imports } from '@gsa/contracts';
import { dec, DomainError, importedSaleFigures, isoDate, money, toMoney, type ImportWarningKind, type Money } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { authorize, type Ctx } from '../context';
import { audit, inTx, type Executor } from '../platform';
import { openImportBatch, recordImportedPayment, recordImportedSale, recordImportedStore, type ImportFile } from './history';

const {
  importBatches, importWarnings, payments, products, skus, storeLedgerEntries, stores, users, varieties,
} = schema;

/**
 * The history import (M13 step h; IMP-001, IMP-002, IMP-004, IMP-009; ADR-0059): the import file our tools write
 * from Green Agro's books, checked against this database first — the dry run — and then loaded as one batch: its
 * stores awaiting re-verification, its sales and payments recorded as written, its warnings for the Super Admin.
 * Nothing is posted to an account here; that happens as each store is re-verified (IMP-005).
 */

export type HistoryFile = imports.HistoryImportFile;

/** What a dry run finds: what would be loaded, what stops it loading, and what the Super Admin would be warned of. */
export type HistoryPlan = {
  readonly problems: readonly string[];
  readonly counts: {
    readonly stores: number; readonly sales: number; readonly lines: number; readonly linesInCatalogue: number;
    readonly payments: number; readonly paymentsWithNoStore: number; readonly warnings: Readonly<Partial<Record<ImportWarningKind, number>>>;
  };
  readonly billed: Money; readonly paid: Money;
  /** The seller each name in the books is, as given (`--seller Name=email`). */
  readonly sellers: ReadonlyMap<string, string>;
  /** Each product a line names, as the catalogue SKU it is — or null where none matches. */
  readonly products: ReadonlyMap<string, string | null>;
};

const productKey = (p: { name: string; variety?: string | null | undefined; packGrams?: number | null | undefined }) =>
  `${p.name.trim().toLowerCase()}|${p.variety?.trim().toLowerCase() ?? ''}|${p.packGrams ?? ''}`;
const recordKey = (r: { book: string; bookRow: number }) => `${r.book}#${r.bookRow}`;

/** IMP-004: the dry run — the file checked against this database, and nothing written. */
export async function planHistoryImport(db: Executor, file: HistoryFile, sellerEmails: ReadonlyMap<string, string>): Promise<HistoryPlan> {
  const problems: string[] = [];

  // Sellers: every name the file uses is an active seller here.
  const names = new Set([...file.stores.map((s) => s.seller), ...file.sales.map((s) => s.seller), ...file.payments.map((p) => p.seller)]);
  const sellers = new Map<string, string>();
  const emails = [...names].flatMap((n) => { const e = sellerEmails.get(n); return e ? [e.toLowerCase()] : []; });
  const accounts = emails.length
    ? await db.select({ id: users.id, email: users.email, role: users.role, status: users.status }).from(users).where(inArray(users.email, emails)) : [];
  for (const name of names) {
    const email = sellerEmails.get(name)?.toLowerCase();
    const account = accounts.find((a) => a.email === email);
    if (!email) problems.push(`seller "${name}": not given — add --seller "${name}=<email>"`);
    else if (account?.role !== 'SELLER' || account.status !== 'ACTIVE') problems.push(`seller "${name}": ${email} is not an active seller here`);
    else sellers.set(name, account.id);
  }

  // Stores: each key once; everything else names one of them.
  const storeKeys = new Set<string>();
  for (const s of file.stores) {
    if (storeKeys.has(s.key)) problems.push(`store "${s.key}" appears twice`);
    storeKeys.add(s.key);
  }
  const unknownStore = (key: string | null, where: string) => { if (key !== null && !storeKeys.has(key)) problems.push(`${where}: no store "${key}"`); };

  // Sales: real dates and figures, one serial per seller.
  const serials = new Set<string>();
  const saleRecords = new Set<string>();
  let billed = dec('0');
  for (const s of file.sales) {
    const where = `${s.book} row ${s.bookRow}`;
    unknownStore(s.store, where);
    try { isoDate(s.soldOn, 'soldOn'); } catch { problems.push(`${where}: no such date ${s.soldOn}`); }
    const serial = `${s.seller}#${s.serial}`;
    if (serials.has(serial)) problems.push(`${where}: ${s.seller}'s invoice ${s.serial} appears twice`);
    serials.add(serial);
    saleRecords.add(recordKey(s));
    try {
      billed = billed.plus(dec(importedSaleFigures(s.lines.map((l) => money(l.amount)), money(s.discount ?? '0')).total));
    } catch {
      problems.push(`${where}: its lines and discount leave nothing to bill`);
    }
  }

  // Payments: real dates and amounts, one voucher number each; never more paid than billed in a store.
  const vouchers = new Set<string>();
  const paymentRecords = new Set<string>();
  const byStore = new Map<string, { billed: ReturnType<typeof dec>; paid: ReturnType<typeof dec> }>();
  const of = (key: string) => byStore.get(key) ?? byStore.set(key, { billed: dec('0'), paid: dec('0') }).get(key) ?? { billed: dec('0'), paid: dec('0') };
  for (const s of file.sales) {
    try { of(s.store).billed = of(s.store).billed.plus(dec(importedSaleFigures(s.lines.map((l) => money(l.amount)), money(s.discount ?? '0')).total)); } catch { /* reported above */ }
  }
  let paid = dec('0');
  for (const p of file.payments) {
    const where = `${p.book} row ${p.bookRow}`;
    unknownStore(p.store, where);
    try { isoDate(p.paidOn, 'paidOn'); } catch { problems.push(`${where}: no such date ${p.paidOn}`); }
    if (!dec(p.amount).gt(0)) problems.push(`${where}: a payment of nothing`);
    if (p.kind === 'VOUCHER' && p.voucherNumber) {
      if (vouchers.has(p.voucherNumber)) problems.push(`${where}: voucher ${p.voucherNumber} appears twice`);
      vouchers.add(p.voucherNumber);
    }
    if (p.kind === 'PAID_AT_SALE' && !p.invoiceSerial) problems.push(`${where}: money paid at a sale names no invoice`);
    paymentRecords.add(recordKey(p));
    paid = paid.plus(dec(p.amount));
    if (p.store !== null) of(p.store).paid = of(p.store).paid.plus(dec(p.amount));
  }
  for (const [key, figures] of byStore) {
    // The store would be in credit at re-verification (IMP-005): our tools hold such payments back as warnings.
    if (figures.paid.gt(figures.billed)) problems.push(`store "${key}": paid ${figures.paid.toFixed(2)}, more than billed ${figures.billed.toFixed(2)}`);
  }

  // Warnings: each about something in the file.
  const warnings: Partial<Record<ImportWarningKind, number>> = {};
  for (const w of file.warnings) {
    warnings[w.kind] = (warnings[w.kind] ?? 0) + 1;
    if (w.store !== undefined) unknownStore(w.store, `warning ${w.kind}`);
    if (w.sale && !saleRecords.has(recordKey(w.sale))) problems.push(`warning ${w.kind}: no sale at ${recordKey(w.sale)}`);
    if (w.payment && !paymentRecords.has(recordKey(w.payment))) problems.push(`warning ${w.kind}: no payment at ${recordKey(w.payment)}`);
  }

  // Products: each a line names, matched to the catalogue by name, variety and pack weight.
  const wanted = new Map<string, NonNullable<HistoryFile['sales'][number]['lines'][number]['product']>>();
  for (const s of file.sales) for (const l of s.lines) if (l.product) wanted.set(productKey(l.product), l.product);
  const catalogue = wanted.size === 0 ? [] : await db.select({
    id: skus.id, product: products.nameEn, variety: varieties.nameEn, grams: skus.packWeightG,
  }).from(skus).innerJoin(products, eq(products.id, skus.productId)).leftJoin(varieties, eq(varieties.id, skus.varietyId));
  const resolved = new Map<string, string | null>();
  for (const [key, p] of wanted) {
    const matches = catalogue.filter((c) => c.product.trim().toLowerCase() === p.name.trim().toLowerCase()
      && (c.variety ?? '').trim().toLowerCase() === (p.variety ?? '').trim().toLowerCase()
      && (p.packGrams === null || p.packGrams === undefined || (c.grams !== null && dec(c.grams).eq(dec(String(p.packGrams))))));
    resolved.set(key, matches.length === 1 ? (matches[0]?.id ?? null) : null);
  }
  const lines = file.sales.reduce((n, s) => n + s.lines.length, 0);
  const linesInCatalogue = file.sales.reduce((n, s) => n + s.lines.filter((l) => l.product && resolved.get(productKey(l.product))).length, 0);

  return {
    problems,
    counts: {
      stores: file.stores.length, sales: file.sales.length, lines, linesInCatalogue,
      payments: file.payments.length, paymentsWithNoStore: file.payments.filter((p) => p.store === null).length, warnings,
    },
    billed: toMoney(billed), paid: toMoney(paid), sellers, products: resolved,
  };
}

/**
 * IMP-001, IMP-002, IMP-004, IMP-009: the file loaded as one batch, from a plan with no problems — in one
 * transaction, so a batch is all of the file or none of it. Super Admin only.
 */
export async function loadHistoryImport(
  ctx: Ctx, file: HistoryFile, plan: HistoryPlan, files: readonly ImportFile[],
): Promise<{ batch: { id: string; number: number }; stores: number; sales: number; payments: number; warnings: number }> {
  authorize(ctx, 'system.correct_history');
  if (plan.problems.length > 0) throw new Error(`the dry run found ${plan.problems.length} problem(s); nothing was loaded`);
  return inTx(ctx, async (tx) => {
    const batch = await openImportBatch(tx, ctx, { files, note: file.note ?? null });
    const seller = (name: string) => plan.sellers.get(name) ?? '';
    const storeIds = new Map<string, string>();
    for (const s of file.stores) storeIds.set(s.key, (await recordImportedStore(tx, ctx, batch.id, { name: s.name, sellerId: seller(s.seller) })).id);
    const saleIds = new Map<string, string>();
    for (const s of file.sales) {
      const { id } = await recordImportedSale(tx, ctx, batch.id, {
        storeId: storeIds.get(s.store) ?? '', sellerId: seller(s.seller), soldOn: s.soldOn, serial: s.serial, discount: s.discount ?? '0.00',
        book: s.book, bookRow: s.bookRow, storeNameWritten: s.storeNameWritten,
        lines: s.lines.map((l) => ({
          item: l.item, pack: l.pack ?? null, skuId: l.product ? (plan.products.get(productKey(l.product)) ?? null) : null,
          packs: l.packs, unitPrice: l.unitPrice, amount: l.amount,
        })),
      });
      saleIds.set(recordKey(s), id);
    }
    const paymentIds = new Map<string, string>();
    for (const p of file.payments) {
      const { id } = await recordImportedPayment(tx, ctx, batch.id, {
        storeId: p.store === null ? null : (storeIds.get(p.store) ?? null), sellerId: seller(p.seller), paidOn: p.paidOn, amount: p.amount,
        kind: p.kind, method: p.method, voucherNumber: p.voucherNumber ?? null, invoiceSerial: p.invoiceSerial ?? null,
        book: p.book, bookRow: p.bookRow, storeNameWritten: p.storeNameWritten,
      });
      paymentIds.set(recordKey(p), id);
    }
    if (file.warnings.length > 0) {
      await tx.insert(importWarnings).values(file.warnings.map((w) => ({
        batchId: batch.id, kind: w.kind, params: w.params,
        storeId: w.store === undefined ? null : (storeIds.get(w.store) ?? null),
        importedSaleId: w.sale ? (saleIds.get(recordKey(w.sale)) ?? null) : null,
        importedPaymentId: w.payment ? (paymentIds.get(recordKey(w.payment)) ?? null) : null,
        branchId: ctx.branchId, createdBy: ctx.user.id,
      })));
    }
    const result = { batch, stores: file.stores.length, sales: file.sales.length, payments: file.payments.length, warnings: file.warnings.length };
    await audit(tx, ctx, { action: 'migration.history_loaded', entityType: 'import_batch', entityId: batch.id, after: { ...result, billed: plan.billed, paid: plan.paid } });
    return result;
  });
}

/**
 * IMP-004: a whole batch undone — for a large corrected file from Green Agro, loaded again after. Only while nothing
 * of it is in an account and none of its stores is re-verified; its records stay, out of use, and its stores are
 * withdrawn with it. Super Admin only, with a reason.
 */
export async function undoImportBatch(ctx: Ctx, number: number, reason: string): Promise<{ id: string; number: number }> {
  authorize(ctx, 'system.correct_history');
  const why = reason.trim();
  if (!why) throw new DomainError('REASON_REQUIRED', { action: 'undo' });
  return inTx(ctx, async (tx) => {
    const [batch] = await tx.select().from(importBatches).where(eq(importBatches.number, number)).for('update');
    if (!batch) throw new DomainError('NOT_FOUND', { entity: 'import_batch', number });
    if (batch.status !== 'LOADED') throw new DomainError('INVALID_TRANSITION', { from: batch.status, action: 'undo' });
    const [posted] = await tx.select({ id: storeLedgerEntries.id }).from(storeLedgerEntries).where(eq(storeLedgerEntries.importBatchId, batch.id)).limit(1);
    const [paidIn] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.importBatchId, batch.id)).limit(1);
    const [verified] = await tx.select({ id: stores.id }).from(stores)
      .where(and(eq(stores.importBatchId, batch.id), ne(stores.status, 'AWAITING_REVERIFICATION'))).limit(1);
    if (posted || paidIn || verified) throw new DomainError('INVALID_TRANSITION', { from: 'LOADED', action: 'undo', reason: 'IN_USE' });
    await tx.update(importBatches).set({
      status: 'UNDONE', undoneAt: ctx.now, undoneBy: ctx.user.id, undoReason: why, updatedAt: ctx.now, updatedBy: ctx.user.id, version: batch.version + 1,
    }).where(eq(importBatches.id, batch.id));
    await audit(tx, ctx, { action: 'migration.import_batch_undone', entityType: 'import_batch', entityId: batch.id, after: { number, reason: why } });
    return { id: batch.id, number };
  });
}
