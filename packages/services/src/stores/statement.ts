import {
  businessDate, creditStatus, dec, DOCUMENT_RENDER_MAX_ATTEMPTS, documentRenderBackoffMs, DomainError, mediaStorageKey, toMoney, type Money,
} from '@gsa/core';
import { newId, schema } from '@gsa/db';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { authorizeAny, type Ctx } from '../context';
import { audit, inTx, nextDocumentNumber, type Executor } from '../platform';
import { getBlobStore, getDb } from '../runtime';
import type { PdfRenderer } from '../sales';
import { readSettings } from '../system';
import { loadStore } from './access';
import { storeLedger, type LedgerEntry } from './credit';
import { storeStatementHtml, type StatementData, type StatementEntry } from './statement-html';

const { storeStatements, stores, storeAssignments, users, mediaAssets, deliveryDocuments, returns } = schema;

export type StoreStatement = {
  readonly id: string; readonly number: string; readonly asOf: Date; readonly status: 'PENDING' | 'READY' | 'FAILED';
  readonly requestedBy: string;
  /** ADR-0049: its file was deleted under the storage policy. */
  readonly deleted: boolean;
};

/**
 * IMP-010 (ADR-0059): a statement of the store's account as it stands now, for the store to see — numbered at once,
 * printed by the worker. Whoever may see the store may ask for one: its seller on the phone, the office in the console.
 */
export async function requestStoreStatement(ctx: Ctx, storeId: string): Promise<StoreStatement> {
  authorizeAny(ctx, ['stores.onboard', 'stores.view_all']);
  return inTx(ctx, async (tx) => {
    const store = await loadStore(tx, ctx, storeId);
    // IMP-008: an imported store has no account until its seller re-verifies it — its books are on its page.
    if (store.status === 'AWAITING_REVERIFICATION') throw new DomainError('STORE_NOT_ACTIVE', { status: store.status });
    const number = await nextDocumentNumber(tx, 'ST', ctx.now);
    // As of the database's clock — the one every ledger entry, allocation and correction is stamped by.
    const [row] = await tx.insert(storeStatements).values({
      number, storeId, asOf: sql`now()`, requestedBy: ctx.user.id, branchId: ctx.branchId, nextAttemptAt: ctx.now,
      createdAt: ctx.now, createdBy: ctx.user.id, updatedAt: ctx.now, updatedBy: ctx.user.id,
    }).returning();
    if (!row) throw new Error('statement insert returned nothing');
    await audit(tx, ctx, { action: 'stores.statement_requested', entityType: 'store', entityId: storeId, after: { number } });
    const [by] = await tx.select({ name: users.name }).from(users).where(eq(users.id, ctx.user.id));
    return { id: row.id, number, asOf: row.asOf, status: row.status, requestedBy: by?.name ?? '', deleted: false };
  });
}

/** IMP-010: the store's latest statements, newest first. */
export async function listStoreStatements(ctx: Ctx, storeId: string): Promise<StoreStatement[]> {
  authorizeAny(ctx, ['stores.onboard', 'stores.view_all']);
  const db = getDb();
  await loadStore(db, ctx, storeId);
  const rows = await db.select({ s: storeStatements, by: users.name, file: mediaAssets.status }).from(storeStatements)
    .innerJoin(users, eq(users.id, storeStatements.requestedBy))
    .leftJoin(mediaAssets, eq(mediaAssets.id, storeStatements.mediaId))
    .where(eq(storeStatements.storeId, storeId))
    .orderBy(desc(storeStatements.asOf)).limit(10);
  return rows.map((r) => ({ id: r.s.id, number: r.s.number, asOf: r.s.asOf, status: r.s.status, requestedBy: r.by, deleted: r.file === 'PURGED' }));
}

/** IMP-010: the printed statement, for anyone who may see the store. */
export async function storeStatementPdf(ctx: Ctx, storeId: string, statementId: string): Promise<{ number: string; pdf: Uint8Array<ArrayBuffer> }> {
  authorizeAny(ctx, ['stores.onboard', 'stores.view_all']);
  const db = getDb();
  await loadStore(db, ctx, storeId);
  const [row] = await db.select({ s: storeStatements, file: mediaAssets }).from(storeStatements)
    .leftJoin(mediaAssets, eq(mediaAssets.id, storeStatements.mediaId))
    .where(and(eq(storeStatements.id, statementId), eq(storeStatements.storeId, storeId)));
  if (!row) throw new DomainError('NOT_FOUND', { entity: 'store_statement', id: statementId });
  if (row.s.status !== 'READY' || !row.file) throw new DomainError('DOCUMENT_NOT_READY', { status: row.s.status });
  if (row.file.status === 'PURGED') throw new DomainError('FILE_DELETED', { deletedOn: row.file.purgedAt ? businessDate(row.file.purgedAt) : null });
  const pdf = await getBlobStore().get(row.file.storageKey);
  if (!pdf) throw new DomainError('DOCUMENT_NOT_READY', { status: 'MISSING' });
  return { number: row.s.number, pdf };
}

/**
 * The worker's pass, as for delivery documents (ADR-0019, ADR-0037): claims due statements, prints each from the
 * ledger as it stood at its moment, and keeps the PDF as a file of kind STORE_STATEMENT — so the storage policy
 * deletes it after its period (ADR-0049). A failure waits longer each time and, after the last attempt, stays FAILED.
 */
export async function renderPendingStatements(renderer: PdfRenderer, now: Date, batch = 5): Promise<{ rendered: number; failed: number }> {
  let rendered = 0;
  let failed = 0;
  await getDb().transaction(async (tx) => {
    const due = await tx.select().from(storeStatements)
      .where(and(eq(storeStatements.status, 'PENDING'), lte(storeStatements.nextAttemptAt, now)))
      .orderBy(asc(storeStatements.nextAttemptAt)).limit(batch).for('update', { skipLocked: true });
    for (const statement of due) {
      const attempt = statement.attempts + 1;
      try {
        const html = storeStatementHtml(await statementData(tx, statement), { fontCss: renderer.fontCss, logo: renderer.logo });
        const pdf = new Uint8Array(await renderer.render(html));
        const mediaId = newId();
        const key = mediaStorageKey('STORE_STATEMENT', mediaId, 'application/pdf', statement.asOf);
        await getBlobStore().put(key, pdf, 'application/pdf');
        await tx.insert(mediaAssets).values({
          id: mediaId, kind: 'STORE_STATEMENT', status: 'READY', storageKey: key, contentType: 'application/pdf', byteSize: pdf.byteLength,
          uploadedBy: statement.requestedBy, branchId: statement.branchId, createdAt: now, confirmedAt: now,
        });
        await tx.update(storeStatements).set({ status: 'READY', mediaId, attempts: attempt, lastError: null, updatedAt: now })
          .where(eq(storeStatements.id, statement.id));
        rendered += 1;
      } catch (error) {
        await tx.update(storeStatements).set({
          attempts: attempt, status: attempt >= DOCUMENT_RENDER_MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
          nextAttemptAt: new Date(now.getTime() + documentRenderBackoffMs(attempt)),
          lastError: String(error instanceof Error ? error.message : error).slice(0, 500), updatedAt: now,
        }).where(eq(storeStatements.id, statement.id));
        failed += 1;
      }
    }
  });
  return { rendered, failed };
}

/** Everything the statement shows, read as the store's account stood at the statement's moment. */
async function statementData(db: Executor, statement: typeof storeStatements.$inferSelect): Promise<StatementData> {
  const [store] = await db.select().from(stores).where(eq(stores.id, statement.storeId));
  if (!store) throw new Error(`store ${statement.storeId} missing for its statement`);
  const [assigned] = await db.select({ name: users.name }).from(storeAssignments).innerJoin(users, eq(users.id, storeAssignments.sellerId))
    .where(and(eq(storeAssignments.storeId, store.id), isNull(storeAssignments.endedAt)));
  const settings = await readSettings(db);
  const ledger = await storeLedger(db, store.id, statement.asOf);
  const numbers = await referenceNumbers(db, ledger);
  // CRD-004: past due as it was that day — due, plus the grace days, before it.
  const { pastDue } = creditStatus({
    status: store.status, mode: store.creditMode, limit: store.creditLimit as Money, graceDays: settings['credit.grace_days'], today: businessDate(statement.asOf),
    overrideActive: false, committed: '0.00' as Money,
    openDebits: ledger.flatMap((e) => (e.open !== null && e.dueOn ? [{ dueOn: e.dueOn, open: e.open }] : [])),
  });
  // What still stands: an entry a correction replaced and the entry that reversed it cancel out, and count nowhere.
  const standing = ledger.filter((e) => !e.replacedBy && !e.reversalOf);
  const sum = (type: LedgerEntry['entryType']) => standing.filter((e) => e.entryType === type).reduce((total, e) => total.plus(dec(e.amount)), dec('0'));
  const balance = dec(ledger.at(-1)?.balance ?? '0');
  const [billed, paid, returned] = [sum('SALE'), sum('PAYMENT').neg(), sum('CREDIT_NOTE').neg()];
  return {
    number: statement.number, asOf: statement.asOf,
    company: {
      nameEn: settings['company.name_en'] || 'Green Skill Agro', nameAr: settings['company.name_ar'] || 'غرين سكيل أغرو',
      addressEn: settings['company.address_en'], addressAr: settings['company.address_ar'], vatNumber: settings['company.vat_number'],
    },
    store: {
      code: store.code ?? '', name: store.name, owner: store.ownerName, phone: store.contactNumber, address: store.address,
      seller: assigned?.name ?? null, mode: store.creditMode, days: store.creditCycleDays, limit: store.creditLimit as Money,
    },
    entries: ledger.map((e) => statementEntry(e, numbers.get(e.reference.id) ?? null)),
    totals: {
      billed: toMoney(billed), paid: toMoney(paid), returned: toMoney(returned),
      // Balance adjustments, transfers that never arrived and the like: whatever else brings the account to its balance.
      adjusted: toMoney(balance.minus(billed).plus(paid).plus(returned)),
      balance: toMoney(balance), pastDue,
    },
  };
}

/** The numbers the store knows its sales and returns by — the delivery document's and the return's. */
async function referenceNumbers(db: Executor, ledger: readonly LedgerEntry[]): Promise<Map<string, string>> {
  const ids = (type: string) => [...new Set(ledger.filter((e) => e.reference.type === type).map((e) => e.reference.id))];
  const [saleIds, returnIds] = [ids('SALE'), ids('RETURN')];
  const [documents, returned] = [
    saleIds.length ? await db.select({ id: deliveryDocuments.saleId, number: deliveryDocuments.number }).from(deliveryDocuments).where(inArray(deliveryDocuments.saleId, saleIds)) : [],
    returnIds.length ? await db.select({ id: returns.id, number: returns.number }).from(returns).where(inArray(returns.id, returnIds)) : [],
  ];
  return new Map([...documents, ...returned].map((r) => [r.id, r.number]));
}

function statementEntry(e: LedgerEntry, number: string | null): StatementEntry {
  const amount = dec(e.amount);
  const correction = e.replacedBy
    ? (e.replacedBy.movedTo
      ? { en: `Moved to ${e.replacedBy.movedTo} by correction ${e.replacedBy.number}: ${e.replacedBy.reason}`, ar: `نُقل إلى ${e.replacedBy.movedTo} بالتصحيح ${e.replacedBy.number}` }
      : e.replacedBy.removed
        ? { en: `Removed by correction ${e.replacedBy.number}: ${e.replacedBy.reason}`, ar: `أُلغي بالتصحيح ${e.replacedBy.number}` }
        : { en: `Replaced by correction ${e.replacedBy.number}: ${e.replacedBy.reason}`, ar: `استُبدل بالتصحيح ${e.replacedBy.number}` })
    : e.reversalOf
      ? { en: `Reversal, correction ${e.reversalOf.number}`, ar: `عكس قيد، التصحيح ${e.reversalOf.number}` }
      : e.correctionOf
        ? {
          en: `Correction ${e.correctionOf.number}: ${e.correctionOf.reason}${e.correctionOf.was.amount ? ` (was ${e.correctionOf.was.amount})` : ''}${e.correctionOf.movedFrom ? ` (from ${e.correctionOf.movedFrom})` : ''}`,
          ar: `التصحيح ${e.correctionOf.number}`,
        }
        : null;
  return {
    at: e.occurredAt, dueOn: e.open !== null ? e.dueOn : null,
    debit: amount.gt(0) ? e.amount : null, credit: amount.lt(0) ? toMoney(amount.neg()) : null, balance: e.balance,
    what: what(e), detail: detailOf(e, number),
    imported: e.origin === 'IMPORT'
      ? [e.imported?.book, e.imported?.row ? `row ${e.imported.row}` : null, e.imported?.serial ? `#${e.imported.serial}` : null].filter(Boolean).join(' · ')
      : null,
    correction, replaced: Boolean(e.replacedBy || e.reversalOf),
  };
}

function what(e: LedgerEntry): StatementEntry['what'] {
  if (e.reference.type === 'TRANSFER_NOT_RECEIVED') return { en: 'Transfer not received', ar: 'تحويل لم يُستلم' };
  switch (e.entryType) {
    case 'SALE': return { en: 'Sale', ar: 'بيع' };
    case 'PAYMENT': return e.paymentMethod === 'BANK_TRANSFER' ? { en: 'Payment, bank transfer', ar: 'دفعة، تحويل بنكي' } : { en: 'Payment, cash', ar: 'دفعة نقدًا' };
    case 'CREDIT_NOTE': return { en: 'Return', ar: 'مرتجع' };
    case 'ADJUSTMENT': return { en: 'Balance adjustment', ar: 'تسوية الرصيد' };
  }
}

/** The number the store can find the entry by: its document, its voucher, or the payment's. */
function detailOf(e: LedgerEntry, number: string | null): string | null {
  if (number) return number;
  if (e.entryType === 'PAYMENT') {
    const voucher = e.voucher?.number ?? e.imported?.voucherNumber;
    return voucher ? `Voucher ${voucher}` : e.paymentNumber;
  }
  if (e.reference.type === 'TRANSFER_NOT_RECEIVED') return e.paymentNumber;
  return e.entryType === 'ADJUSTMENT' && !e.reversalOf && !e.correctionOf ? e.note : null;
}
