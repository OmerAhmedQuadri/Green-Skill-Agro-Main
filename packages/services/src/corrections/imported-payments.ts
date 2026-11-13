import { correctionReason, DomainError, type ImportedPaymentKind, type Money } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import { audit, inTx, mapUniqueViolations } from '../platform';
import { getDb } from '../runtime';
import { postImportedHistory } from '../stores';
import { requireCorrectionSession } from './sessions';

const { importBatches, importedPaymentAssignments, importedPayments, payments, stores, users } = schema;

/** IMP-009: an imported payment the books placed with no store, as the Super Admin sees it to attach it. */
export type UnassignedPayment = {
  readonly id: string; readonly paidOn: string; readonly amount: Money; readonly kind: ImportedPaymentKind; readonly method: 'CASH' | 'BANK_TRANSFER';
  readonly voucherNumber: string | null; readonly book: string; readonly bookRow: number; readonly storeNameWritten: string; readonly seller: string;
};

/** IMP-009: the imported payments nobody could place and nobody has attached yet, oldest first. */
export async function listUnassignedPayments(ctx: Ctx): Promise<UnassignedPayment[]> {
  authorizeAny(ctx, ['system.correct_history', 'system.view_audit_log']);
  const rows = await getDb().select({ p: importedPayments, seller: users.name }).from(importedPayments)
    .innerJoin(importBatches, eq(importBatches.id, importedPayments.batchId))
    .innerJoin(users, eq(users.id, importedPayments.sellerId))
    .leftJoin(importedPaymentAssignments, eq(importedPaymentAssignments.importedPaymentId, importedPayments.id))
    .where(and(isNull(importedPayments.storeId), isNull(importedPaymentAssignments.id), eq(importBatches.status, 'LOADED')))
    .orderBy(asc(importedPayments.paidOn), asc(importedPayments.bookRow));
  return rows.map((r) => ({
    id: r.p.id, paidOn: r.p.paidOn, amount: r.p.amount as Money, kind: r.p.kind, method: r.p.method, voucherNumber: r.p.voucherNumber,
    book: r.p.book, bookRow: r.p.bookRow, storeNameWritten: r.p.storeNameWritten, seller: r.seller,
  }));
}

/**
 * COR-005 (ADR-0059): a Super Admin attaches an imported payment nobody could place to its store, in their open
 * session and with a reason. It goes into the store's account when the store is re-verified — or at once, if it has
 * been already. Once attached it is corrected on the account, like any payment.
 */
export async function attachImportedPayment(ctx: Ctx, importedPaymentId: string, input: { storeId: string; reason: string }): Promise<void> {
  authorize(ctx, 'system.correct_history');
  const reason = correctionReason(input.reason);
  await inTx(ctx, async (tx) => {
    const session = await requireCorrectionSession(tx, ctx);
    const [payment] = await tx.select({ p: importedPayments, batchStatus: importBatches.status }).from(importedPayments)
      .innerJoin(importBatches, eq(importBatches.id, importedPayments.batchId))
      .where(eq(importedPayments.id, importedPaymentId));
    if (!payment || payment.batchStatus !== 'LOADED') throw new DomainError('NOT_FOUND', { entity: 'imported_payment', id: importedPaymentId });
    if (payment.p.storeId) throw new DomainError('NOT_CORRECTABLE', { reason: 'HAS_STORE' });
    const [posted] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.importedPaymentId, importedPaymentId));
    if (posted) throw new DomainError('ALREADY_CORRECTED');
    const [store] = await tx.select({ id: stores.id, name: stores.name, mode: stores.creditMode }).from(stores).where(eq(stores.id, input.storeId));
    if (!store) throw new DomainError('NOT_FOUND', { entity: 'store', id: input.storeId });
    await mapUniqueViolations(tx.insert(importedPaymentAssignments).values({
      importedPaymentId, storeId: store.id, sessionId: session.id, reason, branchId: ctx.branchId, createdBy: ctx.user.id,
    }), { imported_payment_assignments_payment_unique: new DomainError('ALREADY_CORRECTED') });
    // A store with terms has been re-verified: what it is owed or paid goes into its account now.
    if (store.mode) await postImportedHistory(tx, ctx, store.id);
    await tx.execute(sql`set constraints all immediate`);
    await audit(tx, ctx, {
      action: 'corrections.imported_payment_attached', entityType: 'imported_payment', entityId: importedPaymentId,
      after: { storeId: store.id, store: store.name, amount: payment.p.amount, reason, session: session.number, posted: store.mode !== null },
    });
  });
}
