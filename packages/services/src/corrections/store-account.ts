import {
  businessDate, correctedStoreEntry, correctionReason, dec, DomainError, dueDateFor, isDomainError, onDate, storeEntryKind, toMoney,
  type Money, type StoreCorrectionKind, type StoreEntryChange, type StoreEntryValues,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { cashInHand, postCashCorrection } from '../cash';
import { authorize, authorizeAny, type Ctx } from '../context';
import { audit, inTx, mapUniqueViolations, pageLimit, type Executor, type Tx } from '../platform';
import { getDb } from '../runtime';
import { creditStatuses, lockStoreLedgers, postStoreCredit, postStoreDebit, reinstateSettled } from '../stores';
import { readSettings } from '../system';
import { requireCorrectionSession } from './sessions';

const { correctionSessions, payments, storeCorrections, storeLedgerEntries, stores, transferDecisions, users } = schema;

/**
 * Store-account corrections (COR-002, COR-005; ADR-0059, amended 27 October). Nothing written is changed: a
 * correction reverses the entry it corrects and posts the corrected one, in its Super Admin's open session.
 *
 * A bill is reversed by a credit that settles its own unpaid part first, then the oldest debts — so money paid
 * towards it moves to the corrected bill or to older debts, and a correction that would leave it nowhere to go is
 * refused: a store is never in credit (ADR-0036). A payment is reversed by putting back the debts it settled, by
 * their own due dates; it is marked replaced, and the corrected payment settles the oldest due first.
 */

export type StoreCorrectionInput = StoreEntryChange & {
  readonly reason?: string | null | undefined;
  /** A cash payment taken in the app: correct its collector's cash in hand too (the Super Admin's choice). */
  readonly cashInHand?: boolean | undefined;
};

/** COR-002: what a correction moves — each store's debt, and the collector's cash in hand where chosen. */
export type StoreCorrectionEffect = {
  readonly stores: readonly {
    readonly id: string; readonly name: string;
    readonly owed: { readonly before: Money; readonly after: Money };
    readonly pastDue: { readonly before: Money; readonly after: Money };
  }[];
  readonly cashInHand: { readonly seller: { readonly id: string; readonly name: string }; readonly before: Money; readonly after: Money } | null;
};

export type StoreCorrectionView = {
  readonly id: string; readonly number: number; readonly session: { readonly id: string; readonly number: number };
  readonly kind: StoreCorrectionKind;
  readonly store: { readonly id: string; readonly name: string }; readonly toStore: { readonly id: string; readonly name: string } | null;
  readonly before: StoreEntryValues; readonly after: StoreEntryValues | null;
  readonly reason: string; readonly cashInHand: boolean; readonly by: string; readonly at: Date;
};

/** COR-002, COR-005: correct one entry of a store's account, with its own reason, in the caller's open session. */
export async function correctStoreEntry(
  ctx: Ctx, entryId: string, input: StoreCorrectionInput,
): Promise<{ correction: StoreCorrectionView; effect: StoreCorrectionEffect }> {
  authorize(ctx, 'system.correct_history');
  return inTx(ctx, async (tx) => {
    const { id, effect } = await apply(tx, ctx, entryId, input, correctionReason(input.reason));
    const [correction] = await viewsOf(tx, [id]);
    if (!correction) throw new Error('store correction not found after insert');
    return { correction, effect };
  });
}

class Rehearsed extends Error {
  constructor(readonly effect: StoreCorrectionEffect) { super('rehearsed'); }
}

/**
 * COR-002: the effect a correction would have, before it is confirmed — found by making it and rolling it back, so
 * what is shown is exactly what confirming does. Needs the session, as the correction does.
 */
export async function previewStoreCorrection(ctx: Ctx, entryId: string, input: StoreCorrectionInput): Promise<StoreCorrectionEffect> {
  authorize(ctx, 'system.correct_history');
  try {
    await getDb().transaction(async (tx) => {
      const { effect } = await apply(tx, ctx, entryId, input, input.reason?.trim() || '(preview)');
      throw new Rehearsed(effect);
    });
  } catch (error) {
    if (error instanceof Rehearsed) return error.effect;
    throw error;
  }
  throw new Error('a rehearsed correction did not roll back');
}

/** The Corrections page: every store-account correction, newest first. */
export async function listStoreCorrections(
  ctx: Ctx, filter: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: StoreCorrectionView[]; nextCursor: string | null }> {
  authorizeAny(ctx, ['system.correct_history', 'system.view_audit_log']);
  const limit = pageLimit(filter.limit);
  const before = filter.cursor && /^\d{1,9}$/.test(filter.cursor) ? Number(filter.cursor) : null;
  if (filter.cursor && before === null) throw new DomainError('INVALID_CURSOR');
  const db = getDb();
  const rows = await db.select({ id: storeCorrections.id, number: storeCorrections.number }).from(storeCorrections)
    .where(before === null ? undefined : lt(storeCorrections.number, before))
    .orderBy(desc(storeCorrections.number)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { items: await viewsOf(db, page.map((r) => r.id)), nextCursor: rows.length > limit && last ? String(last.number) : null };
}

async function apply(
  tx: Tx, ctx: Ctx, entryId: string, input: StoreCorrectionInput, reason: string,
): Promise<{ id: string; effect: StoreCorrectionEffect }> {
  const session = await requireCorrectionSession(tx, ctx);
  const [entry] = await tx.select().from(storeLedgerEntries).where(eq(storeLedgerEntries.id, entryId));
  if (!entry) throw new DomainError('NOT_FOUND', { entity: 'store_ledger_entry', id: entryId });
  const kind = storeEntryKind(entry);
  const [corrected] = await tx.select({ number: storeCorrections.number }).from(storeCorrections).where(eq(storeCorrections.originalEntryId, entryId));
  if (corrected) throw new DomainError('ALREADY_CORRECTED', { number: corrected.number });

  const [payment] = kind === 'PAYMENT' ? await tx.select().from(payments).where(eq(payments.ledgerEntryId, entryId)) : [];
  if (kind === 'PAYMENT' && !payment) throw new DomainError('NOT_CORRECTABLE', { reason: 'NO_PAYMENT' });
  const [decision] = payment?.method === 'BANK_TRANSFER'
    ? await tx.select().from(transferDecisions).where(eq(transferDecisions.paymentId, payment.id)) : [];
  if (payment?.method === 'BANK_TRANSFER' && payment.origin === 'APP') {
    // ADR-0059 (amended): a transfer awaiting its check is decided first; one that never arrived has left the account.
    if (!decision) throw new DomainError('TRANSFER_NOT_DECIDED', { number: payment.number });
    if (decision.outcome === 'NOT_RECEIVED') throw new DomainError('NOT_CORRECTABLE', { reason: 'TRANSFER_NOT_RECEIVED' });
  }

  const original: StoreEntryValues = {
    amount: toMoney(dec(payment ? payment.amount : entry.amount)), date: businessDate(entry.occurredAt), storeId: entry.storeId,
    voucherNumber: payment?.voucherNumber ?? null,
  };
  const after = correctedStoreEntry(kind, original, input, businessDate(ctx.now));
  const affected = [...new Set([original.storeId, ...(after ? [after.storeId] : [])])];
  await lockStoreLedgers(tx, affected);
  const storeRows = await tx.select().from(stores).where(inArray(stores.id, affected));
  if (storeRows.length !== affected.length) throw new DomainError('NOT_FOUND', { entity: 'store', id: after?.storeId });
  const cashApplies = payment?.method === 'CASH' && payment.origin === 'APP' && input.cashInHand === true;
  const owedBefore = await creditStatuses(tx, storeRows, ctx.now);
  const cashBefore = cashApplies && payment ? await cashInHand(tx, payment.receivedBy) : null;

  const id = newId();
  const [row] = await mapUniqueViolations(tx.insert(storeCorrections).values({
    id, sessionId: session.id, kind, storeId: original.storeId, toStoreId: after && after.storeId !== original.storeId ? after.storeId : null,
    originalEntryId: entryId, originalPaymentId: payment?.id ?? null, before: original, after, reason, cashInHand: cashApplies,
    branchId: ctx.branchId, createdBy: ctx.user.id,
  }).returning({ number: storeCorrections.number }), { store_corrections_original_entry_unique: new DomainError('ALREADY_CORRECTED') });
  if (!row) throw new Error('store correction insert returned nothing');

  // Reversing and corrected entries keep the original's origin: an imported bill corrected is still imported (IMP-003).
  const posted = { origin: { origin: entry.origin, importBatchId: entry.importBatchId } };
  if (kind === 'BILL') {
    if (after) {
      const dueOn = after.date === original.date && after.storeId === original.storeId ? entry.dueOn : await dueOnFor(tx, after.storeId, after.date);
      await postStoreDebit(tx, ctx, {
        storeId: after.storeId, entryType: entry.entryType === 'SALE' ? 'SALE' : 'ADJUSTMENT', amount: after.amount,
        referenceType: 'CORRECTION', referenceId: id, note: entry.note, dueOn, occurredAt: onDate(entry.occurredAt, original.date, after.date), ...posted,
      });
    }
    await placed(original.storeId, postStoreCredit(tx, ctx, {
      storeId: original.storeId, entryType: 'ADJUSTMENT', amount: original.amount, referenceType: 'CORRECTION_REVERSAL', referenceId: id,
      firstDebitId: entryId, ...posted,
    }));
  } else if (payment) {
    await reinstateSettled(tx, ctx, { storeId: original.storeId, creditEntryId: entryId, referenceType: 'CORRECTION_REVERSAL', referenceId: id, note: null, ...posted });
    await tx.update(payments).set({ supersededBy: id }).where(eq(payments.id, payment.id));
    if (after) {
      const paymentId = newId();
      const receivedAt = onDate(payment.receivedAt, original.date, after.date);
      const { entryId: creditId } = await placed(after.storeId, postStoreCredit(tx, ctx, {
        storeId: after.storeId, entryType: 'PAYMENT', amount: after.amount, referenceType: 'PAYMENT', referenceId: paymentId, occurredAt: receivedAt, ...posted,
      }));
      await mapUniqueViolations(tx.insert(payments).values({
        id: paymentId, number: `${payment.number.replace(/(-C\d+)+$/, '')}-C${row.number}`, storeId: after.storeId, amount: after.amount,
        method: payment.method, reference: payment.reference, receivedAt, receivedBy: payment.receivedBy, ledgerEntryId: creditId,
        voucherNumber: after.voucherNumber, voucherPhotoId: payment.voucherPhotoId, origin: payment.origin, importBatchId: payment.importBatchId,
        importedPaymentId: payment.importedPaymentId, correctionId: id, branchId: payment.branchId,
      }), { payments_voucher_number_unique: new DomainError('DUPLICATE_VOUCHER', { number: after.voucherNumber }) });
      // A confirmed transfer keeps its confirmation: the money arrived; only what was written about it changes.
      if (decision?.outcome === 'CONFIRMED') {
        await tx.insert(transferDecisions).values({
          paymentId, outcome: 'CONFIRMED', reason: null, decidedAt: decision.decidedAt, decidedBy: decision.decidedBy, branchId: decision.branchId,
        });
      }
    }
    if (cashApplies) {
      const difference = dec(after?.amount ?? '0').minus(dec(original.amount));
      if (!difference.isZero()) {
        await postCashCorrection(tx, ctx, { sellerId: payment.receivedBy, amount: toMoney(difference), referenceType: 'STORE_CORRECTION', referenceId: id });
      }
    }
  }

  // The ledger's own guarantees, checked now rather than at commit, so a breach reads as what it is.
  try {
    await tx.execute(sql`set constraints all immediate`);
  } catch (error) {
    const constraint = (error as { cause?: { constraint?: string } }).cause?.constraint;
    if (constraint === 'store_balance_non_negative') throw new DomainError('CORRECTION_LEAVES_CREDIT', {});
    throw error;
  }

  const owedAfter = await creditStatuses(tx, storeRows, ctx.now);
  const [collector] = cashApplies && payment ? await tx.select({ name: users.name }).from(users).where(eq(users.id, payment.receivedBy)) : [];
  const effect: StoreCorrectionEffect = {
    stores: storeRows.map((s) => ({
      id: s.id, name: s.name,
      owed: { before: owedBefore.get(s.id)?.outstanding ?? zero, after: owedAfter.get(s.id)?.outstanding ?? zero },
      pastDue: { before: owedBefore.get(s.id)?.pastDue ?? zero, after: owedAfter.get(s.id)?.pastDue ?? zero },
    })),
    cashInHand: cashBefore !== null && payment
      ? { seller: { id: payment.receivedBy, name: collector?.name ?? '' }, before: cashBefore, after: await cashInHand(tx, payment.receivedBy) }
      : null,
  };
  await audit(tx, ctx, {
    action: 'corrections.store_entry_corrected', entityType: 'store_correction', entityId: id,
    before: original, after: { values: after, kind, reason, session: session.number, cashInHand: cashApplies },
  });
  return { id, effect };
}

const zero = '0.00' as Money;

/** A credit a correction posts that the store owes too little to take: the money would leave it in credit. */
async function placed<T>(storeId: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (isDomainError(error) && error.code === 'PAYMENT_EXCEEDS_BALANCE') throw new DomainError('CORRECTION_LEAVES_CREDIT', { storeId, ...error.details });
    throw error;
  }
}

/** A corrected bill's due date, by its store's credit terms from its own date (ADR-0036). */
async function dueOnFor(tx: Tx, storeId: string, date: string): Promise<string> {
  const [store] = await tx.select({ mode: stores.creditMode, days: stores.creditCycleDays }).from(stores).where(eq(stores.id, storeId));
  if (!store) throw new DomainError('NOT_FOUND', { entity: 'store', id: storeId });
  return dueDateFor(store.mode, store.days, date, (await readSettings(tx))['credit.week_closes_on']);
}

async function viewsOf(db: Executor, ids: readonly string[]): Promise<StoreCorrectionView[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({ c: storeCorrections, sessionNumber: correctionSessions.number, by: users.name }).from(storeCorrections)
    .innerJoin(correctionSessions, eq(correctionSessions.id, storeCorrections.sessionId))
    .innerJoin(users, eq(users.id, storeCorrections.createdBy))
    .where(inArray(storeCorrections.id, [...ids]))
    .orderBy(desc(storeCorrections.number));
  const storeIds = [...new Set(rows.flatMap((r) => [r.c.storeId, ...(r.c.toStoreId ? [r.c.toStoreId] : [])]))];
  const names = new Map((await db.select({ id: stores.id, name: stores.name }).from(stores).where(inArray(stores.id, storeIds))).map((s) => [s.id, s.name]));
  return rows.map((r) => ({
    id: r.c.id, number: r.c.number, session: { id: r.c.sessionId, number: r.sessionNumber }, kind: r.c.kind,
    store: { id: r.c.storeId, name: names.get(r.c.storeId) ?? '' },
    toStore: r.c.toStoreId ? { id: r.c.toStoreId, name: names.get(r.c.toStoreId) ?? '' } : null,
    before: r.c.before as StoreEntryValues, after: (r.c.after as StoreEntryValues | null) ?? null,
    reason: r.c.reason, cashInHand: r.c.cashInHand, by: r.by, at: r.c.createdAt,
  }));
}
