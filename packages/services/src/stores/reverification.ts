import {
  balanceConfirmation, businessDayStart, dec, DomainError, dueDateFor, initialStoreStatus, isDomainError, toMoney, voucherNumber,
  type BalanceConfirmation, type ImportedPaymentKind, type Money,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import { notify } from '../notifications';
import { audit, inTx, nextDocumentNumber, type Executor, type Tx } from '../platform';
import { getDb } from '../runtime';
import { readSettings, readToggles } from '../system';
import { loadStore, readingAsManager, type Store } from './access';
import { postStoreCredit, postStoreDebit } from './credit';
import { checkedStoreDetails, duplicatesOf, type StoreDetailsInput } from './onboarding';

const {
  importBatches, importedPaymentAssignments, importedPayments, importedSales, payments, saleCorrections, storeLedgerEntries, storeReverifications, stores, users,
} = schema;

/**
 * Imported stores and their history (M13; IMP-005, IMP-008; ADR-0059, amended 27 October). A store imported from
 * Green Agro's books awaits re-verification. Its seller fills in what the books lack — the onboarding details and
 * terms — and shows the store what its books come to; the store agrees or disputes. At that moment its imported sales
 * and payments go into its account: each bill due on its own date plus the terms just set, each payment settling the
 * oldest due first. No stock, cash in hand or commission moves (IMP-006).
 */

/** IMP-005: an imported store's sales and payments not in its account yet, and what they come to. */
export type ImportedHistory = {
  readonly sales: readonly {
    readonly id: string; readonly soldOn: string; readonly serial: number; readonly book: string; readonly total: Money; readonly seller: string;
  }[];
  readonly payments: readonly {
    readonly id: string; readonly paidOn: string; readonly amount: Money; readonly kind: ImportedPaymentKind; readonly method: 'CASH' | 'BANK_TRANSFER';
    readonly voucherNumber: string | null; readonly book: string; readonly seller: string;
  }[];
  readonly billed: Money; readonly paid: Money; readonly balance: Money;
};

/** IMP-005: what is waiting to go into a store's account — shown to the store at re-verification. */
export async function importedHistory(ctx: Ctx, storeId: string): Promise<ImportedHistory> {
  authorizeAny(ctx, ['stores.onboard', 'stores.view_all']);
  const db = ctx.tx ?? getDb();
  await loadStore(db, ctx, storeId);
  return unposted(db, storeId);
}

export type ReverifyInput = StoreDetailsInput & {
  readonly acknowledgeDuplicates?: boolean | undefined;
  /** What the seller showed the store, and what it said. A dispute carries its words (IMP-008). */
  readonly balance: { readonly shown: string; readonly confirmation: BalanceConfirmation; readonly disputeNote?: string | null | undefined };
};

/**
 * IMP-005, IMP-008: the seller re-verifies an imported store — the details onboarding asks for, and the balance the
 * store was shown, agreed or disputed. Its imported history goes into its account then. A dispute is flagged for the
 * Super Admin; with approval on, the store waits for a manager as a new one would (STO-009).
 */
export async function reverifyStore(ctx: Ctx, storeId: string, input: ReverifyInput): Promise<Store> {
  authorize(ctx, 'stores.onboard');
  const said = balanceConfirmation(input.balance.confirmation, input.balance.disputeNote);
  return inTx(ctx, async (tx) => {
    await tx.select({ id: stores.id }).from(stores).where(eq(stores.id, storeId)).for('update');
    const before = await loadStore(tx, ctx, storeId); // the seller's own store, or view_all
    if (before.status !== 'AWAITING_REVERIFICATION') throw new DomainError('INVALID_TRANSITION', { from: before.status, action: 'reverify' });
    const { location, columns } = await checkedStoreDetails(tx, ctx, input);
    const duplicates = (await duplicatesOf(tx, { ...location, name: columns.name })).filter((d) => d.storeId !== storeId);
    if (duplicates.length > 0 && !input.acknowledgeDuplicates) throw new DomainError('DUPLICATE_STORE_WARNING', { duplicates });

    // What the store agreed or disputed is what goes into its account: if it changed meanwhile, show it again.
    const history = await unposted(tx, storeId);
    if (!dec(history.balance).eq(dec(input.balance.shown))) throw new DomainError('IMPORTED_BALANCE_CHANGED', { balance: history.balance });

    const status = initialStoreStatus((await readToggles(tx))['stores.approval_required']);
    await tx.update(stores).set({ ...columns, status, updatedAt: ctx.now, updatedBy: ctx.user.id, version: sql`${stores.version} + 1` })
      .where(eq(stores.id, storeId));
    await postImportedHistory(tx, ctx, storeId);
    await tx.insert(storeReverifications).values({
      storeId, importedBalance: history.balance, confirmation: said.confirmation, disputeNote: said.note,
      reverifiedAt: ctx.now, reverifiedBy: ctx.user.id, branchId: ctx.branchId,
    });
    if (status === 'PENDING_APPROVAL') {
      await notify(tx, ctx, { permission: 'stores.approve' }, 'STORE_PENDING_APPROVAL', { name: columns.name }, `/console/stores/${storeId}`, storeId);
    }
    if (said.confirmation === 'DISPUTED') {
      await notify(tx, ctx, { permission: 'system.correct_history' }, 'STORE_BALANCE_DISPUTED',
        { name: columns.name, amount: history.balance, note: said.note }, `/console/stores/${storeId}`);
    }
    await audit(tx, ctx, {
      action: 'stores.reverified', entityType: 'store', entityId: storeId,
      after: {
        name: columns.name, status, creditMode: columns.creditMode, creditLimit: columns.creditLimit, importedBalance: history.balance,
        sales: history.sales.length, payments: history.payments.length, confirmation: said.confirmation, disputeNote: said.note,
        duplicatesAcknowledged: duplicates.map((d) => d.storeId),
      },
    });
    return loadStore(tx, readingAsManager(ctx), storeId);
  });
}

/**
 * IMP-005: a verified store's imported sales and payments not yet in its account, posted — the bills first, each due
 * on its own date plus the store's terms, then the payments by date, each settling the oldest due first. Both keep
 * their origin and batch (IMP-003). An imported payment gets a payment of its own (PI-…), with no voucher photo and no
 * cash in hand (IMP-006).
 */
export async function postImportedHistory(tx: Tx, ctx: Ctx, storeId: string): Promise<void> {
  const [store] = await tx.select({ mode: stores.creditMode, days: stores.creditCycleDays }).from(stores).where(eq(stores.id, storeId));
  if (!store?.mode) throw new DomainError('STORE_NOT_ACTIVE', { status: 'AWAITING_REVERIFICATION' });
  const weekClosesOn = (await readSettings(tx))['credit.week_closes_on'];
  const history = await unposted(tx, storeId);
  const batches = await batchesOf(tx, history);
  for (const sale of history.sales) {
    await postStoreDebit(tx, ctx, {
      storeId, entryType: 'SALE', amount: sale.total, referenceType: 'IMPORTED_SALE', referenceId: sale.id,
      dueOn: dueDateFor(store.mode, store.days, sale.soldOn, weekClosesOn), occurredAt: midday(sale.soldOn),
      origin: { origin: 'IMPORT', importBatchId: batches.sales.get(sale.id) ?? null },
    });
  }
  for (const paid of history.payments) {
    const id = newId();
    const at = midday(paid.paidOn);
    const importBatchId = batches.payments.get(paid.id) ?? null;
    let credit: { entryId: string };
    try {
      credit = await postStoreCredit(tx, ctx, {
        storeId, entryType: 'PAYMENT', amount: paid.amount, referenceType: 'PAYMENT', referenceId: id, occurredAt: at,
        origin: { origin: 'IMPORT', importBatchId },
      });
    } catch (error) {
      // The books paid more than they billed: the import holds such payments back (IMP-009), so this is a fault there.
      if (isDomainError(error) && error.code === 'PAYMENT_EXCEEDS_BALANCE') throw new DomainError('IMPORTED_HISTORY_IN_CREDIT', { storeId, ...error.details });
      throw error;
    }
    const voucher = await standingVoucher(tx, paid.voucherNumber);
    await tx.insert(payments).values({
      id, number: await nextDocumentNumber(tx, 'PI', at), storeId, amount: paid.amount, method: paid.method,
      // ADR-0059: an imported bank transfer's reference names its voucher, or where the books wrote it.
      reference: paid.method === 'BANK_TRANSFER' ? (paid.voucherNumber ?? `${paid.book} ${paid.bookRow}`) : null,
      receivedAt: at, receivedBy: paid.sellerId, ledgerEntryId: credit.entryId, voucherNumber: voucher, voucherPhotoId: null,
      origin: 'IMPORT', importBatchId, importedPaymentId: paid.id, branchId: ctx.branchId,
    });
  }
}

const midday = (date: string) => new Date(businessDayStart(date).getTime() + 12 * 60 * 60 * 1000);

/**
 * A voucher number as kept (ADR-0047), unless it is not one or a payment that stands already has it — the books'
 * own number stays on the imported payment either way (IMP-003).
 */
async function standingVoucher(tx: Executor, written: string | null): Promise<string | null> {
  if (!written) return null;
  let number: string;
  try {
    number = voucherNumber(written);
  } catch {
    return null;
  }
  const [taken] = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.voucherNumber, number), isNull(payments.supersededBy)));
  return taken ? null : number;
}

type UnpostedPayment = ImportedHistory['payments'][number] & { readonly sellerId: string; readonly bookRow: number };

async function unposted(db: Executor, storeId: string): Promise<ImportedHistory & { payments: readonly UnpostedPayment[] }> {
  const saleRows = await db.select({ s: importedSales, seller: users.name }).from(importedSales)
    .innerJoin(importBatches, eq(importBatches.id, importedSales.batchId))
    .innerJoin(users, eq(users.id, importedSales.sellerId))
    .where(and(
      eq(importedSales.storeId, storeId), eq(importBatches.status, 'LOADED'), isNull(importedSales.replacedBy),
      // COR-006: an invoice corrected after its bill went into the account is in it already, under an earlier version.
      sql`not exists (
        with recursive versions(id, correction_id) as (
          select ${importedSales.id}, ${importedSales.correctionId}
          union all
          select p.id, p.correction_id from versions v
            join ${saleCorrections} c on c.id = v.correction_id join ${importedSales} p on p.id = c.imported_sale_id
        )
        select 1 from ${storeLedgerEntries} where ${storeLedgerEntries.referenceType} = 'IMPORTED_SALE'
          and ${storeLedgerEntries.referenceId} in (select id from versions))`,
    ))
    .orderBy(asc(importedSales.soldOn), asc(importedSales.serial));
  // A payment the books placed nowhere goes to the store a Super Admin attached it to (COR-005).
  const paymentRows = await db.select({ p: importedPayments, seller: users.name }).from(importedPayments)
    .innerJoin(importBatches, eq(importBatches.id, importedPayments.batchId))
    .innerJoin(users, eq(users.id, importedPayments.sellerId))
    .leftJoin(importedPaymentAssignments, eq(importedPaymentAssignments.importedPaymentId, importedPayments.id))
    .where(and(
      sql`coalesce(${importedPaymentAssignments.storeId}, ${importedPayments.storeId}) = ${storeId}`, eq(importBatches.status, 'LOADED'),
      sql`not exists (select 1 from ${payments} where ${payments.importedPaymentId} = ${importedPayments.id})`,
    ))
    .orderBy(asc(importedPayments.paidOn), asc(importedPayments.bookRow));
  const billed = saleRows.reduce((t, r) => t.plus(dec(r.s.total)), dec('0'));
  const paid = paymentRows.reduce((t, r) => t.plus(dec(r.p.amount)), dec('0'));
  return {
    sales: saleRows.map((r) => ({ id: r.s.id, soldOn: r.s.soldOn, serial: r.s.serial, book: r.s.book, total: r.s.total as Money, seller: r.seller })),
    payments: paymentRows.map((r) => ({
      id: r.p.id, paidOn: r.p.paidOn, amount: r.p.amount as Money, kind: r.p.kind, method: r.p.method, voucherNumber: r.p.voucherNumber,
      book: r.p.book, bookRow: r.p.bookRow, seller: r.seller, sellerId: r.p.sellerId,
    })),
    billed: toMoney(billed), paid: toMoney(paid), balance: toMoney(billed.minus(paid)),
  };
}

async function batchesOf(db: Executor, history: ImportedHistory) {
  const saleIds = history.sales.map((s) => s.id);
  const paymentIds = history.payments.map((p) => p.id);
  const saleRows = saleIds.length
    ? await db.select({ id: importedSales.id, batchId: importedSales.batchId }).from(importedSales).where(inArray(importedSales.id, saleIds)) : [];
  const paymentRows = paymentIds.length
    ? await db.select({ id: importedPayments.id, batchId: importedPayments.batchId }).from(importedPayments).where(inArray(importedPayments.id, paymentIds)) : [];
  return { sales: new Map(saleRows.map((r) => [r.id, r.batchId])), payments: new Map(paymentRows.map((r) => [r.id, r.batchId])) };
}
