import {
  CUSTOMER_CODE_PREFIX, customerCode, dec, DomainError, importedPaymentAmount, importedSaleFigures, isoDate, money, quantity,
  type ImportedPaymentKind, type Money,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { audit, nextInSeries, type Tx } from '../platform';

const { importBatches, importedSales, importedSaleLines, importedPayments, priceLists, storeAssignments, stores, users } = schema;

/**
 * Imported history (M13, ADR-0059): Green Agro's sellers' invoice and payment books, recorded as written in the
 * caller's transaction. Recording posts nothing — a store's imported sales and payments go into its account when
 * the seller re-verifies it (IMP-005), and never touch stock, cash in hand or commission (IMP-006). The import use
 * case that calls these authorises the caller; their input is the import's own reading of the books, so input that
 * breaks a rule of the books' shape is a fault in that reading, not something to tell a user.
 */

/** IMP-004: a file as loaded — its name, its SHA-256 and its size — so a batch can be traced to exact files. */
export type ImportFile = { readonly name: string; readonly sha256: string; readonly bytes: number };

const SHA256 = /^[0-9a-f]{64}$/;

/** IMP-004: one run of the history import, numbered, from the files it read. */
export async function openImportBatch(
  tx: Tx, ctx: Ctx, input: { files: readonly ImportFile[]; note?: string | null },
): Promise<{ id: string; number: number }> {
  if (input.files.length === 0) throw new Error('an import batch needs the files it was read from');
  for (const f of input.files) {
    if (!f.name.trim() || !SHA256.test(f.sha256) || !Number.isInteger(f.bytes) || f.bytes <= 0) {
      throw new Error(`import file "${f.name}": a name, a SHA-256 and a size are required`);
    }
  }
  const files = input.files.map((f) => ({ name: f.name.trim(), sha256: f.sha256, bytes: f.bytes }));
  const [row] = await tx.insert(importBatches).values({
    files, note: input.note?.trim() || null, branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
  }).returning({ id: importBatches.id, number: importBatches.number });
  if (!row) throw new Error('import batch insert returned nothing');
  await audit(tx, ctx, { action: 'migration.import_batch_opened', entityType: 'import_batch', entityId: row.id, after: { number: row.number, files } });
  return row;
}

/**
 * IMP-008: a store from the books, with only what they give — its name and the seller whose books name it. It awaits
 * re-verification: its seller fills in the rest then, and its imported history goes into its account. It takes its
 * Customer ID now (DOC-009) and the base price list until re-verified.
 */
export async function recordImportedStore(
  tx: Tx, ctx: Ctx, batchId: string, input: { name: string; sellerId: string },
): Promise<{ id: string; code: string }> {
  const name = input.name.trim();
  if (!name) throw new Error('an imported store needs a name');
  const [seller] = await tx.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, input.sellerId));
  if (seller?.role !== 'SELLER' || seller.status !== 'ACTIVE') throw new DomainError('NOT_FOUND', { entity: 'seller', id: input.sellerId });
  const [base] = await tx.select({ id: priceLists.id }).from(priceLists).where(eq(priceLists.isBase, true));
  if (!base) throw new Error('no base price list');
  const id = newId();
  const code = customerCode('STORE', await nextInSeries(tx, CUSTOMER_CODE_PREFIX.STORE));
  await tx.insert(stores).values({
    id, code, name, status: 'AWAITING_REVERIFICATION', priceListId: base.id, importBatchId: batchId,
    branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id,
  });
  await tx.insert(storeAssignments).values({ storeId: id, sellerId: input.sellerId, startedAt: ctx.now, assignedBy: ctx.user.id, branchId: ctx.branchId });
  await audit(tx, ctx, { action: 'migration.store_imported', entityType: 'store', entityId: id, after: { name, code, sellerId: input.sellerId, batchId } });
  return { id, code };
}

/** Where a record was written (IMP-003): the book, its row, and the store's name as written there. */
type Written = { readonly book: string; readonly bookRow: number; readonly storeNameWritten: string };

export type ImportedSaleInput = Written & {
  readonly storeId: string; readonly sellerId: string; readonly soldOn: string; readonly serial: number;
  /** The discount written on the invoice; a total the seller rounded down is a discount too. */
  readonly discount?: string;
  readonly lines: readonly {
    readonly item: string; readonly pack?: string | null; readonly skuId?: string | null;
    readonly packs: string; readonly unitPrice: string; readonly amount: string;
  }[];
};

/** IMP-001: one invoice of a seller's book, with its lines as written. */
export async function recordImportedSale(
  tx: Tx, ctx: Ctx, batchId: string, input: ImportedSaleInput,
): Promise<{ id: string; subtotal: Money; total: Money }> {
  const written = writtenAt(input);
  if (!Number.isInteger(input.serial) || input.serial <= 0) throw new Error(`${input.book} row ${input.bookRow}: no invoice serial`);
  const lines = input.lines.map((l, i) => {
    const packs = quantity(l.packs);
    if (!dec(packs).gt(0)) throw new DomainError('INVALID_QUANTITY', { line: i + 1, value: l.packs });
    if (!l.item.trim()) throw new Error(`${input.book} row ${input.bookRow}: line ${i + 1} names no item`);
    return { item: l.item.trim(), pack: l.pack?.trim() || null, skuId: l.skuId ?? null, packs, unitPrice: money(l.unitPrice), amount: money(l.amount) };
  });
  const discount = money(input.discount ?? '0.00');
  const { subtotal, total } = importedSaleFigures(lines.map((l) => l.amount), discount);
  const id = newId();
  await tx.insert(importedSales).values({
    id, batchId, storeId: input.storeId, sellerId: input.sellerId, soldOn: isoDate(input.soldOn, 'soldOn'), serial: input.serial,
    ...written, subtotal, discount, total, branchId: ctx.branchId, createdBy: ctx.user.id,
  });
  await tx.insert(importedSaleLines).values(lines.map((l, i) => ({
    importedSaleId: id, lineNo: i + 1, itemWritten: l.item, packWritten: l.pack, skuId: l.skuId,
    packs: l.packs, unitPrice: l.unitPrice, amount: l.amount,
  })));
  return { id, subtotal, total };
}

export type ImportedPaymentInput = Written & {
  /** None when nobody could say which store paid: it waits as a warning (IMP-009). */
  readonly storeId: string | null;
  readonly sellerId: string; readonly paidOn: string; readonly amount: string;
  readonly kind: ImportedPaymentKind; readonly method: 'CASH' | 'BANK_TRANSFER';
  /** VOUCHER: the number written in the voucher book, when there is one. */
  readonly voucherNumber?: string | null;
  /** PAID_AT_SALE: the invoice whose "Paid Amount" this is. */
  readonly invoiceSerial?: number | null;
};

/** IMP-002: one payment of a seller's books — a voucher, or money paid at a sale with no voucher. */
export async function recordImportedPayment(tx: Tx, ctx: Ctx, batchId: string, input: ImportedPaymentInput): Promise<{ id: string }> {
  const written = writtenAt(input);
  const amount = importedPaymentAmount(input.amount);
  const voucherNumber = input.kind === 'VOUCHER' ? input.voucherNumber?.trim() || null : null;
  const invoiceSerial = input.kind === 'PAID_AT_SALE' ? input.invoiceSerial ?? null : null;
  if (input.kind === 'PAID_AT_SALE' && (!Number.isInteger(invoiceSerial) || (invoiceSerial ?? 0) <= 0)) {
    throw new Error(`${input.book} row ${input.bookRow}: money paid at a sale names no invoice`);
  }
  const id = newId();
  await tx.insert(importedPayments).values({
    id, batchId, storeId: input.storeId, sellerId: input.sellerId, paidOn: isoDate(input.paidOn, 'paidOn'), amount,
    kind: input.kind, method: input.method, voucherNumber, invoiceSerial, ...written, branchId: ctx.branchId, createdBy: ctx.user.id,
  });
  return { id };
}

function writtenAt(input: Written): Written {
  if (!input.book.trim() || !Number.isInteger(input.bookRow) || input.bookRow <= 0) {
    throw new Error(`"${input.book}" row ${input.bookRow}: an imported record needs its book and row`);
  }
  return { book: input.book.trim(), bookRow: input.bookRow, storeNameWritten: input.storeNameWritten.trim() };
}
